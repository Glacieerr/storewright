import { scheduleYard, type YardSchedule, type YardVisit } from '@storewright/yard';
import { better, type ApptPlan, type ApptStats } from './hubs';
import { HARD } from './policy';
import type { HubYard } from './types';

/**
 * 预约错峰的效果用场地排程器算（@storewright/yard 的 scheduleYard，和三维里收货场的车走的同一份排程）：
 * 按场地布置把当天的车逐辆排进场——场外等候、待命车道排队、进场调车、倒车靠台、卸货、拉出——挪之前排一次，挪之后再排一次。
 *
 * 挑挪哪几辆还是排队模型（hubs.ts 的 planAppointments：先到先服务、按月台数）挑的：场地排程器排一次要逐辆走一遍场地，
 * 拿它一辆辆试太慢。排队模型挑出来的车，按顺序一辆辆交给场地排程器验证，只留下排出来确实更好（冷链车等待也不超限）的。
 *
 * 等待 = 场外等候 + 待命车道排队（hold、queue 两段），不算进场调车、倒车；排队最多同时几辆 = 同时在这两段的车。
 * 和排队模型一样，只数此刻以后才到的车（按原来的到达时刻）。
 */
export interface YardAppt {
  before: ApptStats;
  after: ApptStats;
  /** 场地排程器确认了的挪动 */
  moves: ApptPlan['moves'];
  /** 排队模型挑了、场地排程器算出来不更好（或对不上场地里的访问）没放进来的 */
  dropped: number;
  /** 场地排程里此刻以后才到的车 */
  trucks: number;
}

const WAIT = new Set(['hold', 'queue']);

function stats(s: YardSchedule, later: (v: YardVisit) => boolean): ApptStats & { waits: Map<string, number> } {
  const waits = new Map<string, number>();
  const ev: [number, number][] = [];
  let sum = 0;
  let max = 0;
  let cold = 0;
  for (const tl of s.timelines) {
    if (!later(tl.visit)) continue;
    let w = 0;
    for (const sg of tl.segs)
      if (WAIT.has(sg.kind) && sg.t1 > sg.t0) {
        w += sg.t1 - sg.t0;
        ev.push([sg.t0, 1], [sg.t1, -1]);
      }
    waits.set(tl.visit.id, w);
    sum += w;
    max = Math.max(max, w);
    if (tl.visit.vehicle === 'reefer') cold = Math.max(cold, w);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let q = 0;
  let peak = 0;
  for (const [, d] of ev) {
    q += d;
    peak = Math.max(peak, q);
  }
  return { waits, peak, waitMin: sum / 60, maxMin: max / 60, coldMaxMin: cold / 60 };
}

/** 一个访问整体挪 d 秒（到达、靠台、拉出，进场点以前那几段的时刻跟着挪） */
function shift(v: YardVisit, d: number): YardVisit {
  const pcs = (xs: YardVisit['pre']) => xs?.map((p) => ({ ...p, t0: p.t0 + d, t1: p.t1 + d }));
  return { ...v, arrive: v.arrive + d, dockAt: v.dockAt + d, leaveAt: v.leaveAt + d, ...(v.pickupAt !== undefined ? { pickupAt: v.pickupAt + d } : {}), ...(v.pre ? { pre: pcs(v.pre) } : {}), ...(v.script ? { script: pcs(v.script) } : {}) };
}

const strip = (s: ApptStats): ApptStats => ({ peak: s.peak, waitMin: s.waitMin, maxMin: s.maxMin, coldMaxMin: s.coldMaxMin });

/** 没有访问、排程器出错返回 undefined（回答改用排队模型的数） */
export function yardAppointments(yard: HubYard, p: ApptPlan, t: number): YardAppt | undefined {
  if (!yard.visits.length) return undefined;
  const arrive0 = new Map(yard.visits.map((v) => [v.id, v.arrive] as const));
  const later = (v: YardVisit) => (arrive0.get(v.id) ?? v.arrive) >= t;
  const run = (shifts: ReadonlyMap<string, number>) => {
    try {
      return stats(scheduleYard(yard.plan, yard.visits.map((v) => (shifts.has(v.id) ? shift(v, shifts.get(v.id) as number) : v))), later);
    } catch {
      return undefined;
    }
  };
  const before = run(new Map());
  if (!before) return undefined;
  const coldOk = (s: ReturnType<typeof stats>) => yard.visits.every((v) => v.vehicle !== 'reefer' || !later(v) || (s.waits.get(v.id) ?? 0) <= Math.max(HARD.reeferWaitMin * 60, before.waits.get(v.id) ?? 0));
  const kept: ApptPlan['moves'] = [];
  const shifts = new Map<string, number>();
  let cur = before;
  for (const m of p.moves) {
    const id = yard.visitOf(m.id);
    if (!id || !arrive0.has(id)) continue;
    const trial = new Map(shifts).set(id, m.to - m.from);
    const s = run(trial);
    if (!s || !coldOk(s) || !better(s, cur)) continue;
    shifts.set(id, m.to - m.from);
    kept.push(m);
    cur = s;
  }
  return { before: strip(before), after: strip(cur), moves: kept, dropped: p.moves.length - kept.length, trucks: yard.visits.filter(later).length };
}
