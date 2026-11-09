import { STORE, STORES } from '../region/network';
import type { WSeg } from '../sim/trace';
import type { HubDay, HubKey } from '../hub/types';
import type { Incident } from '../twin/field';
import type { LoopResult } from '../twin/loop';
import type { AssistCtx } from './types';

/**
 * 晚点归因：一辆车比计划晚了多少分钟、晚在哪里。
 *
 * 闭环每分钟记一次每辆车「比计划晚了多少秒」。把这条曲线逐分钟的增量归给那一分钟正在发生的事：
 * 车载终端报了故障 → 故障停车；有让车晚点进的指令 → 按指令；按计划这时应该停在配送中心 → 装车慢、等月台门
 * （等门的分钟按配送中心记的等门时长拆出来）；停在门店 → 等收货口；停在别处 → 停得比计划久；
 * 按计划在路上、这一段离进行中的事故 / 施工 / 拥堵很近 → 路况；其余在路上的 → 路上车速比计划慢。
 * 出发时就带着的延误记为「出发前」，路上追回的记负数。各项加起来正好等于此刻（或开始卸货时）晚了的分钟。
 * 接了仓储中心的作业计划时，这辆车在仓储中心排队的分钟从停靠的那一项里拆出来。只用到此刻为止的数据。
 */
export type Cause = 'start' | 'dc' | 'door' | 'breakdown' | 'incident' | 'road' | 'dwell' | 'storeDock' | 'hold' | 'hubQueue' | 'recovered';
export const CAUSE_LABEL: Record<Cause, string> = {
  start: '出发前就晚了（上一程、交接）',
  dc: '在配送中心装车慢',
  door: '在配送中心等月台门',
  breakdown: '车辆故障停车',
  incident: '路上遇到事故、施工、拥堵',
  road: '路上车速比计划慢（车流、路口）',
  dwell: '途中停靠得比计划久',
  storeDock: '在门店等收货口',
  hold: '按调度指令在路边晚点进',
  hubQueue: '在仓储中心排队',
  recovered: '路上追回',
};

export interface CausePart {
  cause: Cause;
  label: string;
  min: number;
  detail?: string;
}
export interface DelayExplain {
  vid: number;
  id: string;
  /** 算到哪个时刻（此刻，或者到店开始卸货的时刻） */
  asOf: number;
  /** 比计划晚了多少分钟 */
  delayMin: number;
  parts: CausePart[];
  /** 到本店的这一站：开始卸货的时刻、收货截止、按截止晚了几分钟、计划离截止的余量（负数 = 计划本身就晚） */
  store?: { key: string; t: number; close: number; late: number; slackMin: number };
  /** 货改由救援车送 */
  rescuedBy?: number;
  notes: string[];
}

const segLen = new WeakMap<WSeg, number[]>();
/** 计划路线上 τ 时刻应该在的位置（沙盘坐标） */
function planPos(s: WSeg, tau: number): { x: number; z: number } | undefined {
  const p = s.pts;
  if (p.length < 4) return p.length >= 2 ? { x: p[0] as number, z: p[1] as number } : undefined;
  let cum = segLen.get(s);
  if (!cum) {
    cum = [0];
    for (let i = 2; i < p.length; i += 2) cum.push((cum[cum.length - 1] as number) + Math.hypot((p[i] as number) - (p[i - 2] as number), (p[i + 1] as number) - (p[i - 1] as number)));
    segLen.set(s, cum);
  }
  const total = cum[cum.length - 1] as number;
  const want = total * Math.min(1, Math.max(0, (tau - s.t0) / Math.max(1, s.t1 - s.t0)));
  let k = 1;
  while (k < cum.length - 1 && (cum[k] as number) < want) k++;
  const a = cum[k - 1] as number;
  const f = (cum[k] as number) > a ? (want - a) / ((cum[k] as number) - a) : 0;
  return { x: (p[(k - 1) * 2] as number) + ((p[k * 2] as number) - (p[(k - 1) * 2] as number)) * f, z: (p[(k - 1) * 2 + 1] as number) + ((p[k * 2 + 1] as number) - (p[(k - 1) * 2 + 1] as number)) * f };
}

const isStore = (place: string) => STORES.some((s) => s.key === place);

/** 仓储中心作业计划里这辆车排队的秒数（按作业编号对上），按设施分 */
function hubQueueSec(hubs: readonly HubDay[] | undefined, opId: string | undefined, until: number): { hub: HubKey; sec: number }[] {
  if (!hubs || !opId) return [];
  const out: { hub: HubKey; sec: number }[] = [];
  for (const h of hubs) {
    const queues = new Set(h.zones.filter((z) => z.kind === 'queue').map((z) => z.key));
    let sec = 0;
    for (const f of h.flows) {
      if (f.carrierIn !== opId && f.carrierOut !== opId && f.id !== opId) continue;
      for (const s of f.steps) if (queues.has(s.zone) && s.t0 < until) sec += Math.min(until, s.t1) - s.t0;
    }
    if (sec > 0) out.push({ hub: h.key, sec });
  }
  return out;
}

/** 一辆车到此刻（或到店开始卸货时）晚了多少、晚在哪里；没有现场记录返回 undefined */
export function explainVehicle(ctx: AssistCtx, vid: number): DelayExplain | undefined {
  const res: LoopResult | undefined = ctx.twin?.result;
  if (!res) return undefined;
  const k = res.vids.indexOf(vid);
  const arr = res.delays[k];
  const plan = res.vehicles[k];
  if (k < 0 || !arr || !arr.length || !plan) return undefined;
  const op = ctx.board.ops.find((o) => o.vehicle === vid);
  const id = ctx.rows.find((r) => r.vid === vid)?.id ?? op?.id ?? `车 ${vid}`;
  const stop = res.stops.find((s) => s.vid === vid && s.store === STORE.key);
  const end = stop && stop.t <= ctx.t ? stop.t : ctx.t;
  const notes: string[] = [];

  const faults: [number, number, string][] = [];
  let open: { t: number; note: string } | undefined;
  for (const m of res.msgs) {
    if (m.kind !== 'event' || m.vid !== vid || m.t > end) continue;
    if (m.ev === 'fault' && m.code === 'ENG') open = { t: m.t, note: m.note ?? '车辆故障' };
    else if (m.ev === 'fixed' && open) {
      faults.push([open.t, m.t, open.note]);
      open = undefined;
    }
  }
  if (open) faults.push([open.t, end + 1, open.note]);
  const holds = res.cmds.flatMap((c) => (c.kind === 'hold' && c.vid === vid && c.t <= end ? [[c.t, c.until] as [number, number]] : []));
  const incidents = res.incidents.filter((x) => x.t0 <= end);

  const sec = new Map<Cause, number>();
  const add = (c: Cause, s: number) => sec.set(c, (sec.get(c) ?? 0) + s);
  const hitIncident = new Map<string, Incident>();
  const segs = plan.segs;
  let prev = NaN;
  let last = NaN;
  const mEnd = Math.min(arr.length - 1, Math.floor(end / 60));
  for (let m = 0; m <= mEnd; m++) {
    const d = arr[m] as number;
    if (!Number.isFinite(d)) continue;
    last = d;
    if (!Number.isFinite(prev)) {
      // 第一次有记录：出发时就带着的延误
      if (d > 0) add('start', d);
      prev = d;
      continue;
    }
    const inc = d - prev;
    prev = d;
    if (Math.abs(inc) < 1e-6) continue;
    if (inc < 0) {
      add('recovered', inc);
      continue;
    }
    const t = m * 60;
    const tau = t - d;
    if (faults.some(([a, b]) => t > a && t <= b)) add('breakdown', inc);
    else if (holds.some(([a, b]) => t > a && t <= b)) add('hold', inc);
    else {
      const s = segs.find((x) => x.t0 <= tau && tau < x.t1) ?? [...segs].reverse().find((x) => x.t1 <= tau);
      if (!s) add('start', inc);
      else if (s.place && !s.route) add(s.place === 'DC' ? 'dc' : isStore(s.place) ? 'storeDock' : 'dwell', inc);
      else {
        const p = planPos(s, tau);
        const near = p ? incidents.find((x) => x.t0 <= t && t < x.t1 && Math.hypot(p.x - x.x, p.z - x.z) <= x.r + 40) : undefined;
        if (near) {
          add('incident', inc);
          hitIncident.set(near.id, near);
        } else add('road', inc);
      }
    }
  }
  if (!Number.isFinite(last)) return undefined;

  // 等月台门的分钟从「装车慢」里拆出来；仓储中心排队的从停靠的那一项里拆出来
  const doorSec = Math.min(sec.get('dc') ?? 0, (res.by.door.get(vid) ?? 0) * 60);
  if (doorSec > 0) {
    add('dc', -doorSec);
    add('door', doorSec);
  }
  for (const q of hubQueueSec(ctx.hubs?.(), op?.id, end)) {
    const from: Cause = q.hub === 'store' ? 'storeDock' : q.hub === 'park' ? 'dc' : 'dwell';
    const take = Math.min(sec.get(from) ?? 0, q.sec);
    if (take > 0) {
      add(from, -take);
      add('hubQueue', take);
      notes.push(`其中在${ctx.hubs?.().find((h) => h.key === q.hub)?.label ?? q.hub}排队约 ${Math.round(take / 60)} 分钟（仓储中心的作业计划）。`);
    }
  }

  const order: Cause[] = ['start', 'door', 'dc', 'hubQueue', 'breakdown', 'incident', 'road', 'dwell', 'storeDock', 'hold', 'recovered'];
  const parts: CausePart[] = [];
  for (const c of order) {
    const s = sec.get(c) ?? 0;
    if (Math.abs(s) < 30) continue;
    const detail =
      c === 'incident'
        ? [...hitIncident.values()].map((x) => x.text).join('；')
        : c === 'breakdown'
          ? faults.map((f) => f[2]).join('；')
          : c === 'door'
            ? `配送中心记的等门 ${Math.round((res.by.door.get(vid) ?? 0))} 分钟`
            : undefined;
    // 从区域外开进来的长途车（直送、进货、空运冷藏车）：「出发前」是进区域之前在长途路上、口岸耽误的
    const label = c === 'start' && op && (op.kind === 'direct' || op.kind === 'supplier' || op.kind === 'farm' || op.kind === 'airTruck' || op.kind === 'drayage') ? '进区域之前就晚了（长途路上、口岸）' : CAUSE_LABEL[c];
    parts.push({ cause: c, label, min: s / 60, ...(detail ? { detail } : {}) });
  }
  // 小于半分钟的零头并进最大的一项，保证加起来等于总数
  const total = last / 60;
  const sum = parts.reduce((a, x) => a + x.min, 0);
  if (parts.length && Math.abs(total - sum) > 1e-9) {
    const big = parts.reduce((a, x) => (Math.abs(x.min) > Math.abs(a.min) ? x : a));
    big.min += total - sum;
  }
  const rescue = res.extras.find((x) => x.kind === 'rescue' && x.of === vid);
  let storeInfo: DelayExplain['store'];
  if (stop && stop.t <= ctx.t) {
    const planned = (op?.stops ?? []).find((s) => s.key === STORE.key);
    const closeBase = (planned?.close ?? stop.close / 3600) * 3600;
    storeInfo = { key: STORE.key, t: stop.t, close: stop.close, late: stop.late, slackMin: planned ? (closeBase - planned.start) / 60 : (stop.close - (stop.t - last)) / 60 };
  }
  return { vid, id, asOf: end, delayMin: total, parts, ...(storeInfo ? { store: storeInfo } : {}), ...(rescue ? { rescuedBy: rescue.vid } : {}), notes };
}

export interface StoreExplain {
  /** 到此刻在本店晚到的站 */
  stops: DelayExplain[];
  /** 各项原因合计（分钟） */
  total: CausePart[];
  /** 按收货截止晚了的分钟合计、比计划晚的分钟合计（差的是计划里的余量吸收掉的） */
  lateMin: number;
  delayMin: number;
}

/** 本店到此刻晚到的站，原因合计 */
export function explainStore(ctx: AssistCtx): StoreExplain | undefined {
  const res = ctx.twin?.result;
  if (!res) return undefined;
  const late = res.stops.filter((s) => s.store === STORE.key && s.t <= ctx.t && s.late > 0.5);
  const stops = late.flatMap((s) => {
    const x = explainVehicle(ctx, s.vid);
    return x ? [x] : [];
  });
  const sum = new Map<Cause, number>();
  for (const x of stops) for (const p of x.parts) sum.set(p.cause, (sum.get(p.cause) ?? 0) + p.min);
  const total = [...sum.entries()].filter(([, v]) => Math.abs(v) >= 0.5).map(([c, v]) => ({ cause: c, label: CAUSE_LABEL[c], min: v })).sort((a, b) => b.min - a.min);
  return { stops, total, lateMin: late.reduce((a, s) => a + s.late, 0), delayMin: stops.reduce((a, x) => a + x.delayMin, 0) };
}
