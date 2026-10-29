import { rankReasons, type Reason } from '@storewright/ai';
import type { DeliveryPlan } from '../deliveries';
import type { EquipmentTrace, InboundMetrics, PalletRecord, Truck } from '../inbound';
import { congestionAt, type TrafficParams } from '../traffic';
import { avg, confidenceOf, type Advice } from './types';

/**
 * 到货与卸货场的建议（决策记录 0020 · 方向 1）：
 * - 卸货门排队：哪段时间来的车多于卸货门，在场内等了多久；试着把附近一家供应商的预约挪到它送货时段里卸货门空闲的时刻，
 *   再仿真看排队能少多少（冷藏车排队标为紧急）；
 * - 晚到的车：按路况（拥堵、学校上学放学、铁路道口）预测谁会晚到，收货员按预计到达时刻准备；
 * - 收货员人数：多一个人卸货到入库能快多少，少一个人会不会变慢。
 */

/** 一次到货仿真的结果 */
export interface InboundRun {
  trucks: Truck[];
  metrics: InboundMetrics;
  pallets: PalletRecord[];
  equipment: EquipmentTrace[];
}

/** 对到货、后仓试的改动 */
export interface InboundAdjust {
  /** 到货编号 → 新的预约时刻（当天的秒数） */
  appt?: Record<string, number>;
  receivers?: number;
  nightCrew?: number;
  slotting?: 'default' | 'velocity';
  liftOrder?: 'fifo' | 'urgency';
}

/** 到货的「实验台」：当前方案的参数和一个可以按改动、按随机种子重跑的函数（模拟器的工作线程提供） */
export interface InboundLab {
  /** 当前方案、基准种子下的到货排班（预约、供应商送货时段） */
  plans: DeliveryPlan[];
  docks: number;
  receivers: number;
  nightCrew: number;
  /** 两层的门店（有货梯） */
  twoFloor: boolean;
  traffic?: TrafficParams;
  /** 跑一次到货仿真 */
  run(adjust: InboundAdjust, seed: number): InboundRun;
  /** seeds[0] 是当前方案的种子，其余是「别的几天」 */
  seeds: readonly number[];
}

/** 在场内等过 10 分钟算排队 */
export const QUEUE_SEC = 10 * 60;
/** 比预约晚 15 分钟以上算晚到 */
export const LATE_SEC = 15 * 60;

export const yardWait = (t: Truck): number => Math.max(0, t.dockAt - t.arrive);
export const totalYardWaitMin = (r: InboundRun): number => r.trucks.reduce((s, t) => s + yardWait(t), 0) / 60;
const round1 = (v: number) => Math.round(v * 10) / 10;

/** 这个时刻场地里（排队或靠台）有几辆车 */
function inYard(run: InboundRun, t0: number, t1: number): number {
  return run.trucks.filter((t) => t.arrive < t1 && t.goneAt > t0).length;
}

/** 路况因素：拥堵、学校、铁路道口（作为「为什么」） */
function trafficReasons(traffic: TrafficParams | undefined, t: number): Reason[] {
  if (!traffic) return [];
  const out: Reason[] = [];
  const c = congestionAt(traffic, t);
  if (c > 0.05) out.push({ factor: 'CONGESTION', value: Math.round(c * 100) / 100, weight: 0, effect: { kind: 'ADD', amount: Math.round(c * 10) } });
  const h = t / 3600;
  if (traffic.extra?.some((x) => h >= x.from - 0.5 && h <= x.to + 0.25)) out.push({ factor: 'SCHOOL_RUSH', weight: 0, effect: { kind: 'ADD', amount: 6 } });
  if (traffic.railway) out.push({ factor: 'RAILWAY', weight: 0, effect: { kind: 'ADD', amount: 3 } });
  return out;
}

export function adviseInbound(lab: InboundLab, runs: readonly InboundRun[]): Advice[] {
  const base = runs[0];
  if (!base) return [];
  const out: Advice[] = [];
  const twoSeeds = lab.seeds.slice(0, Math.min(2, lab.seeds.length));

  // ---------- 1. 卸货门排队 ----------
  const waiting = base.trucks.filter((t) => yardWait(t) >= QUEUE_SEC).sort((a, b) => a.arrive - b.arrive);
  const clusters: Truck[][] = [];
  for (const t of waiting) {
    const last = clusters[clusters.length - 1];
    if (last && t.arrive - Math.max(...last.map((x) => x.dockAt)) < 45 * 60) last.push(t);
    else clusters.push([t]);
  }
  for (const cl of clusters.slice(0, 3)) {
    const from = Math.min(...cl.map((t) => t.arrive));
    const to = Math.max(...cl.map((t) => t.dockAt));
    const waitMin = cl.reduce((s, t) => s + yardWait(t), 0) / 60;
    const reefer = cl.some((t) => t.kind === 'REEFER');
    const recurDays = runs.filter((r) => r.trucks.some((t) => yardWait(t) >= QUEUE_SEC && t.arrive >= from - 1800 && t.arrive <= to + 1800)).length;
    // 候选：这段时间前后到的供应商车辆，挪到它送货时段里场地最空的两个时刻
    const near = lab.plans.filter((d) => d.window && d.vendor && d.arrive >= from - 45 * 60 && d.arrive <= to + 15 * 60);
    const trials: Array<{ d: DeliveryPlan; t: number }> = [];
    for (const d of near) {
      const [h0, h1] = d.window as [number, number];
      const options: Array<{ t: number; busy: number }> = [];
      for (let h = h0; h <= h1 + 1e-6; h += 0.25) {
        const t = Math.round(h * 3600);
        if (Math.abs(t - d.appt) < 30 * 60) continue;
        options.push({ t, busy: inYard(base, t - 10 * 60, t + 40 * 60) });
      }
      options.sort((a, b) => a.busy - b.busy || Math.abs(a.t - d.appt) - Math.abs(b.t - d.appt));
      for (const o of options.slice(0, 2)) trials.push({ d, t: o.t });
    }
    let best: { d: DeliveryPlan; t: number; before: number; after: number; consistent: boolean } | undefined;
    const before = avg(twoSeeds.map((_, i) => totalYardWaitMin(runs[i] as InboundRun)));
    for (const tr of trials.slice(0, 4)) {
      const afters = twoSeeds.map((s) => totalYardWaitMin(lab.run({ appt: { [tr.d.id]: tr.t } }, s)));
      const after = avg(afters);
      const consistent = afters.every((a, i) => a <= totalYardWaitMin(runs[i] as InboundRun) + 0.5);
      if (!best || after < best.after) best = { ...tr, before, after, consistent };
    }
    const reasons = rankReasons(
      [
        { factor: 'QUEUE_TRUCKS', value: cl.length, weight: 0.4, params: { from, to } },
        { factor: 'DOCKS', value: lab.docks, weight: 0.25 },
        { factor: 'WAIT_MIN', value: Math.round(waitMin), weight: 0.2 },
        ...(cl.some((t) => t.appt !== undefined && t.arrive - t.appt >= LATE_SEC) ? [{ factor: 'LATE_ARRIVAL', weight: 0.1 }] : []),
        ...(reefer ? [{ factor: 'REEFER_WAITING', weight: 0.3 }] : []),
      ],
      4,
    );
    const params = { from, to, trucks: cl.length, waitMin: Math.round(waitMin), docks: lab.docks };
    const id = `INBOUND:YARD_QUEUE:${Math.round(from / 900)}`;
    if (best && best.before - best.after >= 5) {
      out.push({
        id,
        area: 'INBOUND',
        code: 'YARD_QUEUE',
        severity: reefer ? 'critical' : 'warn',
        from,
        to,
        params: { ...params, label: best.d.label, deliveryId: best.d.id, fromAppt: best.d.appt, toAppt: best.t },
        reasons,
        action: { kind: 'MOVE_APPOINTMENT', deliveryId: best.d.id, from: best.d.appt, to: best.t },
        effect: [{ metric: 'YARD_WAIT', unit: 'MIN', before: round1(best.before), after: round1(best.after), better: 'lower' }],
        confidence: confidenceOf(recurDays / runs.length, best.consistent),
        recur: { days: recurDays, of: runs.length },
        focus: { t: from, kind: 'dock' },
      });
    } else {
      out.push({ id, area: 'INBOUND', code: 'YARD_QUEUE_NO_MOVE', severity: reefer ? 'critical' : 'info', from, to, params, reasons, confidence: confidenceOf(recurDays / runs.length, false), recur: { days: recurDays, of: runs.length }, focus: { t: from, kind: 'dock' } });
    }
  }

  // ---------- 2. 晚到的车（按路况预测到达） ----------
  const late = base.trucks
    .filter((t) => t.appt !== undefined && t.arrive - t.appt >= LATE_SEC)
    .sort((a, b) => b.arrive - (b.appt as number) - (a.arrive - (a.appt as number)))
    .slice(0, 4);
  for (const t of late) {
    const appt = t.appt as number;
    const lateMin = Math.round((t.arrive - appt) / 60);
    const recurDays = runs.filter((r) => r.trucks.some((x) => x.id === t.id && x.appt !== undefined && x.arrive - x.appt >= 10 * 60)).length;
    const reasons = rankReasons([{ factor: 'LATE_MIN', value: lateMin, weight: 0.3 }, ...trafficReasons(lab.traffic, appt), { factor: 'PUNCTUALITY', weight: 0.1 }], 4);
    out.push({
      id: `INBOUND:LATE:${t.id}`,
      area: 'INBOUND',
      code: 'LATE_ARRIVAL',
      severity: t.kind === 'REEFER' ? 'warn' : 'info',
      from: appt,
      to: t.arrive,
      params: { label: t.label, appt, eta: Math.round(t.arrive), lateMin, truckId: t.id },
      reasons,
      confidence: confidenceOf(recurDays / runs.length, false),
      recur: { days: recurDays, of: runs.length },
      focus: { t: Math.max(0, t.arrive - 60), kind: 'truck', ref: t.id },
    });
  }

  // ---------- 3. 收货员人数 ----------
  const cur = lab.receivers;
  const d2s = (r: InboundRun) => r.metrics.dockToStockMin;
  const before = avg(twoSeeds.map((_, i) => d2s(runs[i] as InboundRun)));
  if (before > 0) {
    const plus = twoSeeds.map((s) => lab.run({ receivers: cur + 1 }, s));
    const after = avg(plus.map(d2s));
    if ((before - after) / before >= 0.12) {
      const hours = avg(plus.map((r) => r.metrics.receivingHours)) - avg(twoSeeds.map((_, i) => (runs[i] as InboundRun).metrics.receivingHours));
      out.push({
        id: 'INBOUND:RECEIVERS:+1',
        area: 'INBOUND',
        code: 'RECEIVERS_ADD',
        severity: 'info',
        params: { from: cur, to: cur + 1, trucks: base.trucks.length, pallets: base.metrics.palletsReceived },
        reasons: rankReasons(
          [
            { factor: 'DOCK_TO_STOCK', value: Math.round(before), weight: 0.5 },
            { factor: 'PALLETS_TODAY', value: base.metrics.palletsReceived, weight: 0.3 },
            { factor: 'RECEIVERS', value: cur, weight: 0.2 },
          ],
          3,
        ),
        action: { kind: 'RECEIVERS', from: cur, to: cur + 1 },
        effect: [
          { metric: 'DOCK_TO_STOCK', unit: 'MIN', before: round1(before), after: round1(after), better: 'lower' },
          { metric: 'LABOR_HOURS', unit: 'HOURS', before: 0, after: round1(hours), better: 'lower' },
        ],
        confidence: confidenceOf(plus.every((r, i) => d2s(r) < d2s(runs[i] as InboundRun)) ? 1 : 0.5, true),
      });
    } else if (cur > 1) {
      const minus = twoSeeds.map((s) => lab.run({ receivers: cur - 1 }, s));
      const after2 = avg(minus.map(d2s));
      if ((after2 - before) / before <= 0.03) {
        const hours = avg(twoSeeds.map((_, i) => (runs[i] as InboundRun).metrics.receivingHours)) - avg(minus.map((r) => r.metrics.receivingHours));
        out.push({
          id: 'INBOUND:RECEIVERS:-1',
          area: 'INBOUND',
          code: 'RECEIVERS_REDUCE',
          severity: 'info',
          params: { from: cur, to: cur - 1 },
          reasons: rankReasons(
            [
              { factor: 'DOCK_TO_STOCK', value: Math.round(before), weight: 0.5 },
              { factor: 'RECEIVERS', value: cur, weight: 0.5 },
            ],
            2,
          ),
          action: { kind: 'RECEIVERS', from: cur, to: cur - 1 },
          effect: [
            { metric: 'DOCK_TO_STOCK', unit: 'MIN', before: round1(before), after: round1(after2), better: 'lower' },
            { metric: 'LABOR_HOURS', unit: 'HOURS', before: round1(hours), after: 0, better: 'lower' },
          ],
          confidence: 0.6,
        });
      }
    }
  }
  return out;
}
