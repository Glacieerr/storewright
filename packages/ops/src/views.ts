import type { TempZone } from '@storewright/domain';
import type { HandoffSession, LiveOrder, LiveTote, LiveWalk, OpsState, StoreStatic } from './types';

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
 */
export function suggestSlots(s: OpsState, st: StoreStatic, toteId: string, limit = 3): string[] {
  const t = s.totes[toteId];
  const o = t ? s.orders[t.orderId] : undefined;
  if (!t || !o) return [];
  const sameOrder = new Set(o.toteIds.map((id) => s.totes[id]?.slotCode).filter((c): c is string => !!c));
  return st.slots
    .filter((slot) => slot.tempZone === t.tempZone && (slot.area === 'ANY' || slot.area === o.type) && slotFree(s, st, slot.code) > 0)
    .map((slot) => ({ code: slot.code, score: (sameOrder.has(slot.code) ? 0 : 1000) + (s.slots[slot.code]?.length ?? 0) }))
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
    return !!o && o.lines.some((l) => l.ageRestricted && (o.lineResults[l.lineId]?.picked ?? 0) > 0);
  });
}

/** 交付时要告知顾客的缺货与替代 */
export function orderShortages(o: LiveOrder): Array<{ lineId: string; name: string; short: number; substituteName?: string; substituted: number }> {
  const out: Array<{ lineId: string; name: string; short: number; substituteName?: string; substituted: number }> = [];
  for (const l of o.lines) {
    const r = o.lineResults[l.lineId];
    if (!r || (r.short === 0 && r.substituted === 0)) continue;
    const row: { lineId: string; name: string; short: number; substituteName?: string; substituted: number } = { lineId: l.lineId, name: l.name, short: r.short, substituted: r.substituted };
    if (r.substituteName) row.substituteName = r.substituteName;
    out.push(row);
  }
  return out;
}

/** 已暂存但订单已取消、需要移到回收专区的框 */
export function recoveryNeeded(s: OpsState): LiveTote[] {
  return Object.values(s.totes).filter((t) => t.status === 'STAGED' && s.orders[t.orderId]?.status === 'CANCELLED');
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
