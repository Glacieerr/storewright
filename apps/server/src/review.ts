import { attributeLate, type ReviewDay, type ReviewFactor } from '@storewright/twin';
import { dateOf, dutyOf, outcomeSummary, shiftsOn, slotWindow, weekOf } from '@storewright/ops';
import type { AiService } from './ai';
import { briefPartAt, dayStats, openingBrief, staffingGaps, type BriefDayStats, type BriefItem } from './brief';
import type { StoreRuntime } from './runtime';

/**
 * 打烊复盘（决策记录 0024 · F3）和周报（F5）：数字全部来自事件记录和模型，句子由界面或门店助手按语言拼。
 * - 复盘：今天的迟到订单按原因分开（单量比预测多、拣货的人比排班少、拣货比标准慢、其他），附复刻精度、
 *   今天的缺货里有多少是晚到的车上的商品、采纳的建议和测到的效果、明天要注意的事；
 * - 周报：最近 7 天每天的指标、各模块的说到做到率、下周的单量预测和排班缺口。
 */

const MIN = 60_000;
const DAY = 86_400_000;

function dayStart(date: string): number {
  return new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getTime();
}

export interface ClosingReview {
  date: string;
  actualLate: number;
  replay: number;
  baseline: number;
  factors: Record<ReviewFactor, number>;
  /** 实际迟到减去复刻出来的迟到（复刻解释不了的部分） */
  other: number;
  inputs: { orders: number; forecast: number; pace: number; pickers: number; scheduled: number; perOrderMin: number };
  shortages: { lines: number; lateTruckLines: number };
  recs: { issued: number; adopted: number; measured: number; hits: number };
  notes: BriefItem[];
}

export function closingReview(rt: StoreRuntime, ai: AiService, now = Date.now(), date = dateOf(now)): ClosingReview {
  const s = rt.state;
  const st = rt.statics;
  const from = dayStart(date);
  const to = Math.min(from + DAY, now);
  const len = Math.max(5, st.rules.slotLengthMin) * MIN;
  const hours = ai.context?.hours ?? [];
  const byHour = ai.dayForecast(date)?.byHour ?? [];
  // 只复刻系统在运行、已经开始的时段：系统启动前的时段没有订单和扫描记录，拿预测和它比没有意义；还没到的时段不算
  const observedFrom = Math.max(from, Math.floor((rt.firstEventAt ?? from) / len) * len);
  const orders = Object.values(s.orders).filter((o) => o.status !== 'CANCELLED' && o.slotStart >= from && o.slotStart < from + DAY && o.slotStart <= to);
  // 拣货快慢：今天做完的批次实际用时 ÷ 标准用时；每单的标准用时
  const walks = Object.values(s.walks).filter((w) => w.status === 'COMPLETED' && w.completedAt !== undefined && w.completedAt >= from && w.completedAt < to && w.claimedAt !== undefined);
  const actualSec = walks.reduce((a, w) => a + ((w.completedAt as number) - (w.claimedAt as number)) / 1000, 0);
  const stdSec = walks.reduce((a, w) => a + w.estimatedSec, 0);
  const walkOrders = walks.reduce((a, w) => a + new Set(w.toteIds.map((id) => s.totes[id]?.orderId ?? id.split('-T')[0])).size, 0);
  const pace = stdSec > 0 ? Math.min(3, Math.max(0.5, actualSec / stdSec)) : 1;
  const r = ai.pickRates();
  const perOrderMin = walkOrders ? stdSec / walkOrders / 60 : (r.secPerOrder + (ai.context?.linesPerOrder ?? 6) * r.secPerLine) / 60;
  const scheduleOn = !!s.schedules?.[weekOf(date)];
  const slots: ReviewDay['slots'] = [];
  for (let start = from; start < from + DAY && start <= to; start += len) {
    const h = new Date(start).getHours();
    const win = slotWindow(st, start);
    const n = orders.filter((o) => slotWindow(st, o.slotStart) === win).length;
    // 营业时间以外、系统启动以前的时段：有订单才算
    if (!n && ((hours.length && !hours.includes(h)) || start < observedFrom)) continue;
    // 时段开始前一小时里实际在拣货的人（包括自动运营的虚拟员工）
    const pickers = new Set(Object.values(s.walks).filter((w) => w.associateId && w.claimedAt !== undefined && w.claimedAt < start && (w.completedAt ?? now) > start - 60 * MIN).map((w) => w.associateId)).size;
    const mid = start - 30 * MIN;
    // 排班里的拣货人数；没有发布排班时按名单上在岗的拣货员（和开店简报的「排班」一致）
    const scheduled = scheduleOn
      ? shiftsOn(s, date).filter((x) => x.role === 'PICK' && x.from * MIN + from <= mid && x.to * MIN + from > mid).length + st.roster.filter((a) => a.role === 'PICK' && dutyOf(st, s, a.id, mid).source === 'ROSTER' && dutyOf(st, s, a.id, mid).on).length
      : st.roster.filter((a) => {
          const d = dutyOf(st, s, a.id, mid);
          return d.on && (d.role ?? a.role) === 'PICK';
        }).length;
    slots.push({ start: Math.round((start - from) / MIN), orders: n, forecast: ((byHour[h] ?? 0) * len) / (60 * MIN), pickers, scheduled });
  }
  const res = attributeLate({ slots, perOrderMin, pace });
  const stats = dayStats(s, date, now);
  const actualLate = stats?.late ?? 0;
  // 缺货里有多少是晚到的车上的商品
  const lateItems = new Set(Object.values(s.receipts).filter((x) => x.arrivedAt !== undefined && x.arrivedAt >= from && x.arrivedAt < to && x.arrivedAt > (x.firstExpectedAt ?? x.expectedAt ?? Infinity)).flatMap((x) => x.expected.map((l) => l.itemId)));
  let lines = 0;
  let lateTruckLines = 0;
  for (const o of orders)
    for (const l of o.lines) {
      const rr = o.lineResults[l.lineId];
      if (!rr || rr.short <= 0) continue;
      lines++;
      if (lateItems.has(l.itemId)) lateTruckLines++;
    }
  const recs = Object.values(s.recs).filter((x) => x.issuedAt >= from && x.issuedAt < to);
  const measured = recs.filter((x) => x.outcome?.adopted);
  const notes = openingBrief(rt, ai, now, 'EVENING').watch;
  return {
    date,
    actualLate,
    replay: res.replay,
    baseline: res.baseline,
    factors: res.factors,
    other: actualLate - res.replay,
    inputs: { orders: slots.reduce((a, x) => a + x.orders, 0), forecast: Math.round(slots.reduce((a, x) => a + x.forecast, 0)), pace: Math.round(pace * 100) / 100, pickers: Math.round((slots.reduce((a, x) => a + x.pickers, 0) / Math.max(1, slots.length)) * 10) / 10, scheduled: Math.round((slots.reduce((a, x) => a + x.scheduled, 0) / Math.max(1, slots.length)) * 10) / 10, perOrderMin: Math.round(perOrderMin * 10) / 10 },
    shortages: { lines, lateTruckLines },
    recs: { issued: recs.length, adopted: recs.filter((x) => x.status === 'ACCEPTED' || x.status === 'AUTO_APPLIED').length, measured: measured.length, hits: measured.filter((x) => x.outcome?.hit).length },
    notes,
  };
}

export interface WeeklyReport {
  from: string;
  to: string;
  days: Array<BriefDayStats | { date: string; orders: 0 }>;
  totals: { orders: number; late: number; handedOff: number; avgWaitMin: number; shortLines: number; substitutions: number; coldAlerts: number; recs: number; adopted: number };
  /** 各模块的说到做到率（累计） */
  outcomes: Array<{ module: string; n: number; hitRate?: number; realized?: number }>;
  nextWeek: { orders: number; low: number; high: number; gaps: number; from: string };
}

export function weeklyReport(rt: StoreRuntime, ai: AiService, now = Date.now()): WeeklyReport {
  const s = rt.state;
  const st = rt.statics;
  const today = dateOf(now);
  const dates = Array.from({ length: 7 }, (_, k) => dateOf(dayStart(today) - (6 - k) * DAY + 2 * 3_600_000));
  const days = dates.map((d) => dayStats(s, d, now) ?? { date: d, orders: 0 as const });
  const real = days.filter((d): d is BriefDayStats => d.orders > 0);
  const sum = (f: (d: BriefDayStats) => number) => real.reduce((a, d) => a + f(d), 0);
  const handed = sum((d) => d.handedOff);
  const totals = {
    orders: sum((d) => d.orders),
    late: sum((d) => d.late),
    handedOff: handed,
    avgWaitMin: handed ? Math.round((sum((d) => d.avgWaitMin * d.handedOff) / handed) * 10) / 10 : 0,
    shortLines: sum((d) => d.shortLines),
    substitutions: sum((d) => d.substitutions),
    coldAlerts: sum((d) => d.coldAlerts),
    recs: sum((d) => d.recs),
    adopted: sum((d) => d.adopted),
  };
  const outcomes = Object.entries(s.aiStats)
    .map(([module, x]) => ({ module, o: outcomeSummary(x) }))
    .filter((x) => x.o && x.o.n > 0)
    .map((x) => ({ module: x.module, n: x.o?.n ?? 0, ...(x.o?.hitRate !== undefined ? { hitRate: x.o.hitRate } : {}), ...(x.o?.realized !== undefined ? { realized: x.o.realized } : {}) }));
  // 下周（下周一开始的 7 天）的单量预测和排班缺口
  const nextMonday = (() => {
    const d = new Date(dayStart(today));
    const dow = (d.getDay() + 6) % 7;
    return dateOf(dayStart(today) + (7 - dow) * DAY + 2 * 3_600_000);
  })();
  const next = Array.from({ length: 7 }, (_, k) => dateOf(dayStart(nextMonday) + k * DAY + 2 * 3_600_000));
  let orders = 0;
  let low = 0;
  let high = 0;
  let gaps = 0;
  for (const d of next) {
    const f = ai.dayForecast(d);
    if (f) {
      orders += f.orders;
      low += f.low;
      high += f.high;
    }
    gaps += staffingGaps(ai, st, s, d).length;
  }
  return { from: dates[0] as string, to: today, days, totals, outcomes, nextWeek: { orders, low, high, gaps, from: nextMonday } };
}

/** 现在适合看复盘吗（傍晚以后） */
export function reviewTime(now: number): boolean {
  return briefPartAt(now) === 'EVENING';
}
