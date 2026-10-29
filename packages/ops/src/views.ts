import type { TempZone } from '@storewright/domain';
import type { AreaInfo, BinInfo, HandoffSession, LiveOrder, LiveTote, LiveWalk, OpsState, SlotInfo, StoreStatic } from './types';

/**
 * 读模型：从状态计算界面需要的视图。纯函数，服务端、员工端、模拟器共用。
 */

/** 交付会话的键：配送订单组成行程后按行程交付（一次核验），否则按订单 */
export function sessionKeyFor(s: OpsState, orderId: string): string {
  return s.orders[orderId]?.tripId ?? orderId;
}

/** 验证码哈希的输入：带上订单或行程编号，同一个验证码在不同订单上的哈希不同 */
export function codeHashInput(key: string, code: string): string {
  return `${key}:${code.trim().toUpperCase()}`;
}

/** 交付看板的四种状态（决策 D-04）：未到达灰、即将到达黄、已到达蓝、等待过久红 */
export type BoardColor = 'GREY' | 'YELLOW' | 'BLUE' | 'RED';

export interface BoardRow {
  key: string;
  kind: 'ORDER' | 'TRIP';
  orderIds: string[];
  /** 自取：顾客姓名；行程：行程编号 */
  title: string;
  type: 'PICKUP' | 'DELIVERY';
  shortCode?: string;
  color: BoardColor;
  slotStart: number;
  /** 预计到达：有 AI 修正时用修正值（决策记录 0010），否则用顾客上报的值 */
  etaAt?: number;
  /** 使用 AI 修正时，顾客自己上报的预计到达 */
  reportedEtaAt?: number;
  arrivedAt?: number;
  waitSec: number;
  bay?: string;
  vehicle?: string;
  /** 已暂存的框 / 总框数 */
  staged: number;
  totes: number;
  ready: boolean;
  session?: HandoffSession;
}

/**
 * 交付看板：已到达的按到达先后排在前面（先到先服务），未到达的按时段排列；ETA 只显示，不参与排序（工程约束 EC-7）。
 */
export function handoffBoard(s: OpsState, st: StoreStatic, now: number): BoardRow[] {
  const rows: BoardRow[] = [];
  const approaching = st.rules.approachingMin * 60_000;
  const longWait = st.rules.longWaitMin * 60_000;
  const color = (arrivedAt: number | undefined, etaAt: number | undefined): BoardColor => {
    if (arrivedAt !== undefined) return now - arrivedAt >= longWait ? 'RED' : 'BLUE';
    if (etaAt !== undefined && etaAt - now <= approaching) return 'YELLOW';
    return 'GREY';
  };
  const count = (orders: LiveOrder[]) => {
    let staged = 0;
    let totes = 0;
    for (const o of orders) {
      for (const id of o.toteIds) {
        const t = s.totes[id];
        if (!t) continue;
        totes += 1;
        if (t.status === 'STAGED' || t.status === 'PULLED') staged += 1;
      }
    }
    return { staged, totes };
  };
  for (const tr of Object.values(s.trips)) {
    if (tr.completedAt) continue;
    const orders = tr.orderIds.map((id) => s.orders[id]).filter((o): o is LiveOrder => !!o && o.status !== 'CANCELLED');
    if (!orders.length) continue;
    const c = count(orders);
    const row: BoardRow = {
      key: tr.id,
      kind: 'TRIP',
      orderIds: orders.map((o) => o.id),
      title: tr.id,
      type: 'DELIVERY',
      color: color(tr.arrivedAt, tr.etaAt),
      slotStart: Math.min(...orders.map((o) => o.slotStart)),
      waitSec: tr.arrivedAt !== undefined ? Math.max(0, Math.round((now - tr.arrivedAt) / 1000)) : 0,
      staged: c.staged,
      totes: c.totes,
      ready: orders.every((o) => o.stagedAt !== undefined),
    };
    optional(row, tr.etaAt, tr.arrivedAt, tr.bay, tr.vehicle, s.sessions[tr.id]);
    rows.push(row);
  }
  for (const o of Object.values(s.orders)) {
    if (o.tripId || o.status === 'COMPLETED' || o.status === 'CANCELLED' || o.status === 'CREATED') continue;
    const c = count([o]);
    const row: BoardRow = {
      key: o.id,
      kind: 'ORDER',
      orderIds: [o.id],
      title: displayName(o.firstName, o.lastName),
      type: o.type,
      shortCode: o.shortCode,
      color: color(o.arrivedAt, o.aiEtaAt ?? o.etaAt),
      slotStart: o.slotStart,
      waitSec: o.arrivedAt !== undefined ? Math.max(0, Math.round((now - o.arrivedAt) / 1000)) : 0,
      staged: c.staged,
      totes: c.totes,
      ready: o.stagedAt !== undefined,
    };
    optional(row, o.aiEtaAt ?? o.etaAt, o.arrivedAt, o.bay, o.vehicle, s.sessions[o.id]);
    if (o.aiEtaAt !== undefined && o.etaAt !== undefined) row.reportedEtaAt = o.etaAt;
    rows.push(row);
  }
  return rows.sort((a, b) => {
    const aa = a.arrivedAt !== undefined;
    const ba = b.arrivedAt !== undefined;
    if (aa !== ba) return aa ? -1 : 1;
    if (aa && ba) return (a.arrivedAt as number) - (b.arrivedAt as number) || a.key.localeCompare(b.key);
    return a.slotStart - b.slotStart || a.key.localeCompare(b.key);
  });
}

function optional(row: BoardRow, etaAt?: number, arrivedAt?: number, bay?: string, vehicle?: string, session?: HandoffSession): void {
  if (etaAt !== undefined) row.etaAt = etaAt;
  if (arrivedAt !== undefined) row.arrivedAt = arrivedAt;
  if (bay !== undefined) row.bay = bay;
  if (vehicle !== undefined) row.vehicle = vehicle;
  if (session && session.status !== 'COMPLETED') row.session = session;
}

/** 名 + 姓 */
export function displayName(first: string, last: string): string {
  return last ? `${first} ${last}` : first;
}

export interface ZoneOccupancy {
  tempZone: TempZone;
  used: number;
  capacity: number;
  rate: number;
  alert: boolean;
}

/** 各温区暂存占用率；超过阈值时预警（决策 S-05） */
export function stagingOccupancy(s: OpsState, st: StoreStatic): ZoneOccupancy[] {
  const zones = new Map<TempZone, ZoneOccupancy>();
  for (const slot of st.slots) {
    const z = zones.get(slot.tempZone) ?? { tempZone: slot.tempZone, used: 0, capacity: 0, rate: 0, alert: false };
    z.capacity += slot.capacity;
    z.used += s.slots[slot.code]?.length ?? 0;
    zones.set(slot.tempZone, z);
  }
  const order: TempZone[] = ['AMBIENT', 'CHILLED', 'FROZEN', 'HOT'];
  return order
    .map((z) => zones.get(z))
    .filter((z): z is ZoneOccupancy => !!z)
    .map((z) => {
      z.rate = z.capacity ? z.used / z.capacity : 0;
      z.alert = z.rate >= st.rules.occupancyAlert;
      return z;
    });
}

/** 某个格位还能放几个框 */
export function slotFree(s: OpsState, st: StoreStatic, code: string): number {
  const slot = st.slots.find((x) => x.code === code);
  if (!slot) return 0;
  return slot.capacity - (s.slots[code]?.length ?? 0);
}

/**
 * 暂存格位建议（决策 S-02：员工自选为主，系统建议作为参考）：同订单同温区已占用且未满的格位优先，其次最空的同温区格位。
 * 按到店时间（决策记录 0023 · B5）：半小时内就到的顾客，框放离交付点近的格位；一个半小时以后才到的放远一点，把近的留给快到的。
 */
export function suggestSlots(s: OpsState, st: StoreStatic, toteId: string, limit = 3, now = s.at): string[] {
  const t = s.totes[toteId];
  const o = t ? s.orders[t.orderId] : undefined;
  if (!t || !o) return [];
  const sameOrder = new Set(o.toteIds.map((id) => s.totes[id]?.slotCode).filter((c): c is string => !!c));
  const trip = o.tripId ? s.trips[o.tripId] : undefined;
  const arriveAt = trip ? (trip.arrivedAt ?? trip.etaAt ?? o.slotStart) : (o.arrivedAt ?? o.aiEtaAt ?? o.etaAt ?? o.slotStart);
  const mins = (arriveAt - now) / 60_000;
  const candidates = st.slots
    // 报修中的设备管着的格位不再推荐（预测性维护，决策记录 0022）
    // 换格位时不推荐它现在所在的格位
    .filter((slot) => slot.tempZone === t.tempZone && (slot.area === 'ANY' || slot.area === o.type) && slotFree(s, st, slot.code) > 0 && !s.pausedSlots?.[slot.code] && !(t.status === 'STAGED' && slot.code === t.slotCode));
  const far = Math.max(1, ...candidates.map((x) => x.distM ?? 0));
  const dist = (slot: (typeof candidates)[number]) => (slot.distM === undefined ? 0 : mins <= 30 ? slot.distM : mins >= 90 ? far - slot.distM : 0);
  return candidates
    .map((slot) => ({ code: slot.code, score: (sameOrder.has(slot.code) ? 0 : 1000) + (s.slots[slot.code]?.length ?? 0) + dist(slot) * 2 }))
    .sort((a, b) => a.score - b.score || a.code.localeCompare(b.code))
    .slice(0, limit)
    .map((x) => x.code);
}

/** 拣货清单的一行（按路线顺序展开） */
export interface PickRow {
  stopIndex: number;
  locationId: string;
  toteId: string;
  lineId: string;
  itemId: string;
  name: string;
  gtin: string;
  qty: number;
  done: number;
  allowSubstitution: boolean;
  ageRestricted: boolean;
  /** 订单已取消：跳过 */
  cancelled: boolean;
  toteIndex: number;
  toteCount: number;
  orderShortCode: string;
}

export function pickRows(s: OpsState, walk: LiveWalk): PickRow[] {
  const rows: PickRow[] = [];
  walk.stops.forEach((stop, stopIndex) => {
    for (const p of stop.picks) {
      const t = s.totes[p.toteId];
      const o = t ? s.orders[t.orderId] : undefined;
      const line = o?.lines.find((l) => l.lineId === p.lineId);
      if (!t || !o || !line) continue;
      rows.push({
        stopIndex,
        locationId: stop.locationId,
        toteId: p.toteId,
        lineId: p.lineId,
        itemId: line.itemId,
        name: line.name,
        gtin: line.gtin,
        qty: p.qty,
        done: walk.done[`${p.toteId}|${p.lineId}`] ?? 0,
        allowSubstitution: line.allowSubstitution,
        ageRestricted: line.ageRestricted,
        cancelled: o.status === 'CANCELLED',
        toteIndex: t.index,
        toteCount: t.count,
        orderShortCode: o.shortCode,
      });
    }
  });
  return rows;
}

/** 拣货批次是否全部处理完（取消订单的行不需要处理） */
export function walkRemaining(s: OpsState, walk: LiveWalk): number {
  return pickRows(s, walk).filter((r) => !r.cancelled && r.done < r.qty).length;
}

/** 可领取的拣货批次：按截止时间排序 */
export function openWalks(s: OpsState): LiveWalk[] {
  return Object.values(s.walks)
    .filter((w) => w.status === 'OPEN')
    .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
}

/** 某员工正在做的拣货批次 */
export function activeWalkOf(s: OpsState, associateId: string): LiveWalk | undefined {
  return Object.values(s.walks).find((w) => w.associateId === associateId && (w.status === 'CLAIMED' || w.status === 'PICKING'));
}

/** 准备界面按温区分组：Ambient → Chilled → Frozen → Hot（决策 D-04） */
export function sessionTotes(s: OpsState, orderIds: readonly string[]): LiveTote[] {
  const rank: Record<TempZone, number> = { AMBIENT: 0, CHILLED: 1, FROZEN: 2, HOT: 3 };
  const out: LiveTote[] = [];
  for (const id of orderIds) {
    const o = s.orders[id];
    if (!o || o.status === 'CANCELLED') continue;
    for (const tid of o.toteIds) {
      const t = s.totes[tid];
      if (t && t.status !== 'RECOVERY') out.push(t);
    }
  }
  return out.sort((a, b) => rank[a.tempZone] - rank[b.tempZone] || a.orderId.localeCompare(b.orderId) || a.index - b.index);
}

/** 订单是否含有已拣到的年龄限制商品（交付时需要核验证件） */
export function needsAgeCheck(s: OpsState, orderIds: readonly string[]): boolean {
  return orderIds.some((id) => {
    const o = s.orders[id];
    // 换成替代品的也要核验（替代品通常是同类商品；流程梳理发现，决策记录 0025）
    return !!o && o.lines.some((l) => l.ageRestricted && (o.lineResults[l.lineId]?.picked ?? 0) + (o.lineResults[l.lineId]?.substituted ?? 0) > 0);
  });
}

/** 交付时要告知顾客的缺货与替代 */
export function orderShortages(o: LiveOrder): Array<{ lineId: string; name: string; short: number; substituteName?: string; substituted: number; subAccepted?: boolean }> {
  const out: Array<{ lineId: string; name: string; short: number; substituteName?: string; substituted: number; subAccepted?: boolean }> = [];
  for (const l of o.lines) {
    const r = o.lineResults[l.lineId];
    if (!r || (r.short === 0 && r.substituted === 0)) continue;
    const row: { lineId: string; name: string; short: number; substituteName?: string; substituted: number; subAccepted?: boolean } = { lineId: l.lineId, name: l.name, short: r.short, substituted: r.substituted };
    if (r.substituteName) row.substituteName = r.substituteName;
    if (r.subAccepted !== undefined) row.subAccepted = r.subAccepted;
    out.push(row);
  }
  return out;
}

/** 订单已取消、需要移到回收专区的框：在暂存格位里的，和交付准备时已经取出的 */
export function recoveryNeeded(s: OpsState): LiveTote[] {
  return Object.values(s.totes).filter((t) => (t.status === 'STAGED' || t.status === 'PULLED') && s.orders[t.orderId]?.status === 'CANCELLED');
}

/** 待暂存的框：拣完的，和取出后没在交付准备里、要放回暂存区的；不含自动运营的订单（员工手机不显示） */
export function toStageTotes(s: OpsState): LiveTote[] {
  const inPrep = new Set(Object.values(s.sessions).flatMap((x) => (x.status !== 'COMPLETED' ? x.scanned : [])));
  return Object.values(s.totes)
    .filter((t) => s.orders[t.orderId]?.track !== 'AUTO' && (t.status === 'PICKED' || (t.status === 'PULLED' && !inPrep.has(t.id) && s.orders[t.orderId]?.status !== 'CANCELLED')))
    .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
}

/** 今日概况 */
export interface OpsSummary {
  orders: number;
  completed: number;
  cancelled: number;
  waiting: number;
  openWalks: number;
  activeWalks: number;
  staged: number;
  avgWaitSec: number;
}

export function summary(s: OpsState, now: number): OpsSummary {
  let completed = 0;
  let cancelled = 0;
  let waiting = 0;
  let staged = 0;
  let waitSum = 0;
  let waitN = 0;
  const orders = Object.values(s.orders);
  for (const o of orders) {
    if (o.status === 'COMPLETED') {
      completed += 1;
      if (o.arrivedAt !== undefined && o.completedAt !== undefined) {
        waitSum += (o.completedAt - o.arrivedAt) / 1000;
        waitN += 1;
      }
    } else if (o.status === 'CANCELLED') cancelled += 1;
    else {
      if (o.arrivedAt !== undefined) waiting += 1;
      if (o.stagedAt !== undefined) staged += 1;
    }
  }
  void now;
  const walks = Object.values(s.walks);
  return {
    orders: orders.length,
    completed,
    cancelled,
    waiting,
    openWalks: walks.filter((w) => w.status === 'OPEN').length,
    activeWalks: walks.filter((w) => w.status === 'CLAIMED' || w.status === 'PICKING').length,
    staged,
    avgWaitSec: waitN ? Math.round(waitSum / waitN) : 0,
  };
}

export interface AreaUsage {
  area: AreaInfo;
  used: number;
  capacity: number;
  rate: number;
  alert: boolean;
  /** 这个区域的占用能不能从作业记录里算出来（空托盘区、充电区没有记录） */
  tracked: boolean;
}

/**
 * 每个区域的占用（决策记录 0013）：货架区按占用的托盘位，冷库和待检区按箱数，收货暂放按还没上架的箱数，
 * 暂存区按框数，包裹区按包裹数，熟食保温区按保温中的份数，大件暂存区按已暂存的件数。
 */
export function areaUsage(s: OpsState, st: StoreStatic): AreaUsage[] {
  const areas = st.areas ?? [];
  const binsByArea = new Map<string, BinInfo[]>();
  for (const b of st.bins) if (b.areaId) binsByArea.set(b.areaId, [...(binsByArea.get(b.areaId) ?? []), b]);
  const slotsByArea = new Map<string, SlotInfo[]>();
  for (const sl of st.slots) if (sl.areaId) slotsByArea.set(sl.areaId, [...(slotsByArea.get(sl.areaId) ?? []), sl]);
  const cases = Object.values(s.cases);
  return areas.map((a) => {
    let used = 0;
    let capacity = a.capacity;
    let tracked = true;
    const bins = binsByArea.get(a.id) ?? [];
    switch (a.kind) {
      case 'RACKS':
      case 'OVERSTOCK':
        used = bins.filter((b) => (s.bins[b.code]?.length ?? 0) > 0).length;
        break;
      case 'COOLER':
      case 'FREEZER':
      case 'BULK':
      case 'QA':
      case 'RTV':
      case 'BALER':
      case 'CAGE':
      case 'CHEM':
        used = bins.reduce((n, b) => n + (s.bins[b.code]?.length ?? 0), 0);
        if (!bins.length) tracked = a.kind !== 'CAGE' && a.kind !== 'CHEM';
        break;
      case 'RECEIVING_HOLD':
        used = cases.filter((c) => c.state === 'RECEIVED').length;
        break;
      case 'UNLOAD': {
        const open = new Set(Object.values(s.receipts).filter((r) => r.arrivedAt !== undefined && r.closedAt === undefined).map((r) => r.id));
        used = Math.ceil(cases.filter((c) => c.state === 'RECEIVED' && c.receiptId && open.has(c.receiptId)).length / 20);
        break;
      }
      case 'STAGING':
      case 'STAGING_DELIVERY':
      case 'RECOVERY': {
        const slots = slotsByArea.get(a.id) ?? [];
        used = slots.reduce((n, sl) => n + (s.slots[sl.code]?.length ?? 0), 0);
        if (slots.length) capacity = slots.reduce((n, sl) => n + sl.capacity, 0);
        if (a.kind === 'RECOVERY' && !slots.length) used = Object.values(s.totes).filter((t) => t.status === 'RECOVERY').length;
        break;
      }
      case 'STAGING_OVERSIZED':
        used = Object.values(s.oversized).filter((o) => o.status === 'STAGED').length;
        break;
      case 'HOT_HOLD':
        used = Object.values(s.mto).filter((m) => m.status === 'HELD').reduce((n, m) => n + m.qty, 0);
        break;
      case 'PARCEL':
        used = Object.values(s.parcels).filter((p) => p.status === 'INDUCTED' || p.status === 'STAGED').length;
        break;
      case 'RETURNS':
        used = Object.values(s.returns).filter((r) => r.status === 'OPEN').reduce((n, r) => n + r.lines.reduce((m, l) => m + l.qty, 0), 0);
        break;
      default:
        tracked = false;
    }
    const rate = capacity > 0 ? used / capacity : 0;
    return { area: a, used, capacity, rate, alert: tracked && rate >= a.alertAt, tracked };
  });
}
