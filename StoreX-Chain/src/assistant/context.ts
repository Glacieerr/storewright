import { FAMILIES } from '../region/products';
import { HOUR_W } from '../sim/engine';
import type { KpiPoint, LoopResult } from '../twin/loop';
import type { Policy, UserDecision } from '../twin/types';
import { clock } from '../twin/twin';
import type { StockSnap, TwinSnap, VehRow } from './types';

/** 跨天的时刻写清楚：前一天 22:53、次日 02:00 */
export const dayClock = (t: number): string => (t < 0 ? `前一天 ${clock(t)}` : t >= 24 * 3600 ? `次日 ${clock(t)}` : clock(t));

/**
 * 把闭环的结果在某个时刻切开给值班助手用：到此刻为止的累计结果、此刻的库存、到此刻为止的事件和指令。
 * 网页、孪生服务、测试共用。
 */
export function kpiAt(series: readonly KpiPoint[] | undefined, t: number): KpiPoint | undefined {
  if (!series?.length) return undefined;
  let p: KpiPoint | undefined;
  for (const x of series) {
    if (x.t > t) break;
    p = x;
  }
  return p ?? { t: 0, late: 0, hot: 0, short: 0, cost: 0, lateStops: 0, door: 0, dock: 0 };
}

/** 门店每个商品族此刻的库存（现场、孪生估计）和这个钟点平均每小时卖多少（按当天的需求和小时曲线） */
export function stockAt(res: LoopResult, t: number, demand: Record<string, number>): StockSnap[] {
  const slot = Math.max(0, Math.floor(t / 300) - 1);
  const h = Math.min(23, Math.max(0, Math.floor(t / 3600)));
  // 晚上关门以后按第二天早上的卖法算（不然「每小时卖 0 件」）
  const w = (HOUR_W[h] as number) || (HOUR_W[9] as number);
  return FAMILIES.map((f) => {
    const s = res.stocks.get(f.key);
    const units = s ? (s.truth[Math.min(s.truth.length - 1, slot)] ?? 0) : 0;
    const est = s ? s.est[Math.min(s.est.length - 1, slot)] : undefined;
    return { fam: f.key, label: f.label, units, ...(est !== undefined && Number.isFinite(est) ? { est } : {}), perHour: (demand[f.key] ?? 0) * w, daily: demand[f.key] ?? 0 };
  }).filter((s) => s.units > 0 || (s.est ?? 0) > 0 || s.perHour > 0);
}

/** 按门店每小时的卖货曲线往后推：have 件什么时候卖完（最多看 48 小时；卖不完返回 undefined） */
export function soldOutAt(have: number, daily: number, t: number): number | undefined {
  if (daily <= 0) return undefined;
  let left = have;
  let at = t;
  for (let k = 0; k < 48 * 4; k++) {
    const h = Math.floor(at / 3600) % 24;
    const step = 900 - (at % 900);
    const sell = (daily * (HOUR_W[h] as number) * step) / 3600;
    if (sell >= left && sell > 0) return at + (left / sell) * step;
    left -= sell;
    at += step;
  }
  return undefined;
}

export function twinSnap(closed: LoopResult, open: LoopResult | undefined, t: number, policy: Policy, decisions: readonly UserDecision[], demand: Record<string, number>): TwinSnap {
  const k = kpiAt(closed.series, t);
  const ko = open ? kpiAt(open.series, t) : undefined;
  return {
    policy,
    recs: closed.recs,
    cmds: closed.cmds.filter((c) => c.t <= t),
    decisions,
    ...(k ? { kpi: k } : {}),
    ...(ko ? { openKpi: ko } : {}),
    // 路况是现场发来数据以后孪生才知道的：只给已经开始的
    incidents: closed.incidents.filter((x) => x.t0 <= t),
    stock: stockAt(closed, t, demand),
    events: closed.msgs.flatMap((m) => (m.kind === 'event' && m.t <= t ? [{ t: m.t, vid: m.vid, ev: m.ev, ...(m.note ? { note: m.note } : {}), ...(m.place ? { place: m.place } : {}) }] : [])),
    result: closed,
    ...(open ? { open } : {}),
  };
}

/** 实时跟踪的一行（网页和孪生服务都用 web/src/tracking.ts 的 trackRow）转成助手要的样子 */
export function fromTrack(r: {
  i: number;
  id: string;
  kind: string;
  type: string;
  status: VehRow['status'];
  act: string;
  where: string;
  origin: string;
  dest: string;
  next: string;
  nextPlan?: number;
  nextEta?: number;
  depart?: number;
  end?: number;
  delayMin?: number;
  temp?: { value: number; limit: number };
  load: string;
  cargo: string;
  remainKm?: number;
}): VehRow {
  return {
    vid: r.i,
    id: r.id,
    kind: r.kind,
    type: r.type,
    status: r.status,
    act: r.act,
    ...(r.where ? { where: r.where } : {}),
    origin: r.origin,
    dest: r.dest,
    next: r.next,
    ...(r.nextPlan !== undefined ? { nextPlan: r.nextPlan } : {}),
    ...(r.nextEta !== undefined ? { nextEta: r.nextEta } : {}),
    ...(r.depart !== undefined ? { depart: r.depart } : {}),
    ...(r.end !== undefined ? { end: r.end } : {}),
    ...(r.delayMin !== undefined ? { delayMin: r.delayMin } : {}),
    ...(r.temp ? { temp: r.temp } : {}),
    load: r.load,
    cargo: r.cargo,
    ...(r.remainKm !== undefined ? { remainKm: r.remainKm } : {}),
  };
}
