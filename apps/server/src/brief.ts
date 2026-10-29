import type { Reason } from '@storewright/ai';
import { dateInWeek, dateOf, dutyOf, weekOf, type OpsState, type StoreStatic } from '@storewright/ops';
import type { AiService } from './ai';
import type { StoreRuntime } from './runtime';

/**
 * 开店简报（决策记录 0022 · 第二批 F1）：开店前、中午、傍晚各一页。
 * 数字全部来自工具（订单量模型、排班、事件流），句子由界面按语言拼（模板模式）；
 * 门店助手用同一份数据回答「今天要注意什么」，接上语言模型后说法更自然。
 * - 早上：今天预计多少单（区间、主要原因、高峰）、到货、人手缺口、昨天的指标、今天要注意的 3 件事、需要店长决定的事；
 * - 中午：到现在的实际和预测比、下午的人手缺口；
 * - 傍晚：今天到现在的指标、明天的预测和人手缺口、留给明天的事。
 */

export type BriefPart = 'MORNING' | 'MIDDAY' | 'EVENING';

export interface BriefForecast {
  date: string;
  orders: number;
  low: number;
  high: number;
  /** 平时同一天（星期几）的单量 */
  usual: number;
  reasons: Reason[];
  peakHour?: number;
  peakOrders?: number;
}

/** 人手缺口：某个岗位在一段时间里比需要的少几个人（分钟数是当天的分钟） */
export interface BriefGap {
  role: string;
  from: number;
  to: number;
  short: number;
}

export interface BriefDayStats {
  date: string;
  orders: number;
  handedOff: number;
  late: number;
  avgWaitMin: number;
  shortLines: number;
  substitutions: number;
  coldAlerts: number;
  recs: number;
  adopted: number;
}

/** 要注意的事、要店长决定的事：代码 + 参数（界面翻译） */
export interface BriefItem {
  code: string;
  params?: Record<string, string | number>;
}

export interface Brief {
  at: number;
  part: BriefPart;
  date: string;
  /** 早上、中午：今天的订单预测；傍晚：明天的 */
  forecast?: BriefForecast;
  /** 中午：到现在的实际单数和同一时段的预测（按取货时段） */
  soFar?: { orders: number; expected: number };
  inbound: { trucks: number; cases: number; arrived: number; next?: { supplier: string; at?: number } };
  staffing: { date: string; scheduled: number; gaps: BriefGap[]; absences: number; pendingOffers: number };
  /** 早上：昨天；中午、傍晚：今天到现在 */
  stats?: BriefDayStats;
  watch: BriefItem[];
  decisions: BriefItem[];
}

const MIN = 60_000;
const DAY = 86_400_000;

function dayStart(date: string): number {
  return new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getTime();
}

/** 按当前时刻选早、中、晚 */
export function briefPartAt(now: number): BriefPart {
  const h = new Date(now).getHours();
  return h < 11 ? 'MORNING' : h < 16 ? 'MIDDAY' : 'EVENING';
}

/** 某一天（按取货时段）的运营指标；没有订单时返回 undefined */
export function dayStats(s: OpsState, date: string, until: number): BriefDayStats | undefined {
  const from = dayStart(date);
  const to = Math.min(from + DAY, until);
  const orders = Object.values(s.orders).filter((o) => o.slotStart >= from && o.slotStart < from + DAY && o.status !== 'CANCELLED');
  if (!orders.length) return undefined;
  const done = orders.filter((o) => o.completedAt !== undefined);
  const waits = done.filter((o) => o.arrivedAt !== undefined).map((o) => ((o.completedAt as number) - (o.arrivedAt as number)) / MIN);
  const late = orders.filter((o) => {
    const staged = o.stagedAt ?? (o.status === 'COMPLETED' ? o.completedAt : undefined);
    return staged === undefined ? o.slotStart <= to : staged > o.slotStart;
  }).length;
  const recs = Object.values(s.recs).filter((r) => r.issuedAt >= from && r.issuedAt < to);
  return {
    date,
    orders: orders.length,
    handedOff: done.length,
    late,
    avgWaitMin: waits.length ? Math.round((waits.reduce((a, b) => a + b, 0) / waits.length) * 10) / 10 : 0,
    shortLines: orders.reduce((a, o) => a + Object.values(o.lineResults).filter((r) => r.short > 0).length, 0),
    substitutions: orders.reduce((a, o) => a + Object.values(o.lineResults).filter((r) => r.substituted > 0).length, 0),
    coldAlerts: Object.values(s.walks).filter((w) => w.coldAlerted && (w.startedAt ?? 0) >= from && (w.startedAt ?? 0) < to).length,
    recs: recs.length,
    adopted: recs.filter((r) => r.status === 'ACCEPTED' || r.status === 'AUTO_APPLIED').length,
  };
}

/** 某一天的人手缺口：拣货、暂存、交付每半小时需要的人数（排班需求）对比按排班在岗的人数；从 fromMin 分钟开始看 */
export function staffingGaps(ai: AiService, st: StoreStatic, s: OpsState, date: string, fromMin = 0): BriefGap[] {
  const week = weekOf(date);
  const d = ai.scheduleDemand(week);
  if (!d) return [];
  const day = d.dates.indexOf(date);
  const start = dayStart(date);
  const gaps: BriefGap[] = [];
  for (const role of ['PICK', 'STAGE', 'HANDOFF']) {
    const need = d.demand.find((x) => x.day === day && x.role === role)?.slots;
    if (!need) continue;
    let cur: BriefGap | undefined;
    for (let k = 0; k < 48; k++) {
      const m = k * 30;
      const want = need[k] ?? 0;
      let have = 0;
      if (m >= fromMin && want > 0) for (const a of st.roster) {
        const duty = dutyOf(st, s, a.id, start + (m + 15) * MIN);
        if (duty.on && (duty.role ?? a.role) === role) have++;
      }
      const short = m >= fromMin ? want - have : 0;
      if (short > 0) {
        if (cur && cur.to === m) {
          cur.to = m + 30;
          cur.short = Math.max(cur.short, short);
        } else {
          cur = { role, from: m, to: m + 30, short };
          gaps.push(cur);
        }
      }
    }
  }
  // 影响最大的在前（缺的人数 × 时长）
  return gaps.sort((a, b) => b.short * (b.to - b.from) - a.short * (a.to - a.from) || a.from - b.from).slice(0, 4);
}

/**
 * 技能覆盖（决策记录 0024 · D4）：营业时间里连续 2 小时以上没有在岗的人会年龄核验、开叉车或做熟食时给出缺口，
 * 附一位可以交叉培训的人（那段时间在岗最多、还不会这项技能的人）。只看团队，不评价个人。
 */
export function skillGaps(st: StoreStatic, s: OpsState, date: string, hours: readonly number[]): Array<{ skill: string; from: number; to: number; train?: string }> {
  const start = dayStart(date);
  const has = (a: StoreStatic['roster'][number], sk: string) => a.skills?.includes(sk) || (sk === 'DELI' && a.role === 'DELI') || (sk === 'FORKLIFT' && a.role === 'BACKROOM' && !!a.skills?.includes('FORKLIFT'));
  const skills = ['AGE_CHECK', 'FORKLIFT', ...(st.modules?.mto ? ['DELI'] : [])].filter((sk) => st.roster.some((a) => has(a, sk)));
  const out: Array<{ skill: string; from: number; to: number; train?: string }> = [];
  for (const sk of skills) {
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const from = (run[0] as number) * 60;
        const to = ((run.at(-1) as number) + 1) * 60;
        const onTime = new Map<string, number>();
        for (const h of run) for (const a of st.roster) if (a.role !== 'LEAD' && !has(a, sk) && dutyOf(st, s, a.id, start + (h * 60 + 30) * MIN).on) onTime.set(a.id, (onTime.get(a.id) ?? 0) + 1);
        const train = [...onTime.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0];
        out.push({ skill: sk, from, to, ...(train ? { train: st.roster.find((a) => a.id === train)?.name ?? train } : {}) });
      }
      run = [];
    };
    for (const h of hours) {
      const covered = st.roster.some((a) => has(a, sk) && dutyOf(st, s, a.id, start + (h * 60 + 30) * MIN).on);
      if (covered) flush();
      else run.push(h);
    }
    flush();
  }
  return out;
}

export function openingBrief(rt: StoreRuntime, ai: AiService, now = Date.now(), part: BriefPart = briefPartAt(now)): Brief {
  const s = rt.state;
  const st = rt.statics;
  const today = dateOf(now);
  const tomorrow = dateOf(dayStart(today) + DAY + 2 * 3_600_000);
  const yesterday = dateOf(dayStart(today) - DAY + 2 * 3_600_000);
  const planDate = part === 'EVENING' ? tomorrow : today;
  const nowMin = Math.round((now - dayStart(today)) / MIN);

  // 订单预测
  const f = ai.dayForecast(planDate);
  let forecast: BriefForecast | undefined;
  if (f) {
    const peak = f.byHour.reduce((best, v, h) => (v > (f.byHour[best] ?? 0) ? h : best), 0);
    forecast = { date: planDate, orders: f.orders, low: f.low, high: f.high, usual: f.usual, reasons: f.reasons.slice(0, 3), ...(f.byHour[peak] ? { peakHour: peak, peakOrders: Math.round(f.byHour[peak] as number) } : {}) };
  }
  let soFar: Brief['soFar'];
  if (part === 'MIDDAY' && f) {
    const from = dayStart(today);
    const h = new Date(now).getHours();
    const orders = Object.values(s.orders).filter((o) => o.status !== 'CANCELLED' && o.slotStart >= from && o.slotStart < from + h * 3_600_000).length;
    soFar = { orders, expected: Math.round(f.byHour.slice(0, h).reduce((a, b) => a + b, 0)) };
  }

  // 到货：还没收完的收货单
  const open = Object.values(s.receipts).filter((r) => r.closedAt === undefined);
  const waiting = open.filter((r) => r.arrivedAt === undefined).sort((a, b) => (a.expectedAt ?? a.createdAt) - (b.expectedAt ?? b.createdAt));
  const next = waiting[0];
  const inbound: Brief['inbound'] = {
    trucks: open.length,
    cases: open.reduce((a, r) => a + r.expected.reduce((n, l) => n + l.cases, 0), 0),
    arrived: open.length - waiting.length,
    ...(next ? { next: { supplier: next.supplier, ...(next.expectedAt !== undefined ? { at: next.expectedAt } : {}) } } : {}),
  };

  // 人手
  const gaps = staffingGaps(ai, st, s, planDate, part === 'MIDDAY' ? nowMin : 0);
  const planStart = dayStart(planDate);
  const scheduled = st.roster.filter((a) => {
    for (let m = 5 * 60; m < 23 * 60; m += 60) if (dutyOf(st, s, a.id, planStart + m * MIN).on) return true;
    return false;
  }).length;
  const staffing: Brief['staffing'] = {
    date: planDate,
    scheduled,
    gaps,
    absences: Object.values(s.absences ?? {}).filter((x) => x.date === planDate).length,
    pendingOffers: Object.values(s.offers ?? {}).filter((o) => o.status === 'PENDING').length,
  };

  const stats = part === 'MORNING' ? dayStats(s, yesterday, now) : dayStats(s, today, now);

  // 要注意的事（最多 3 件）：运营预警 > 设备 > 人手缺口 > 单量和平时差得多 > 高峰 > AI 运行状态 > 到货
  const watch: BriefItem[] = [];
  const openRecs = Object.values(s.recs).filter((r) => r.status === 'OPEN');
  for (const r of openRecs.filter((x) => x.module === 'FORESIGHT').sort((a, b) => b.confidence - a.confidence)) watch.push({ code: 'FORESIGHT', params: { problem: r.target, at: Number(r.action.params?.at ?? r.prediction?.from ?? now), baseline: r.prediction?.baseline ?? 0 } });
  for (const r of openRecs.filter((x) => x.module === 'EQUIPMENT')) watch.push({ code: 'EQUIPMENT', params: { sensor: r.target, reason: String(r.action.params?.reason ?? 'RISK') } });
  for (const t of Object.values(s.tickets ?? {}).filter((x) => x.status === 'OPEN')) watch.push({ code: 'TICKET', params: { sensor: t.sensorId, slots: t.slots.length } });
  const g = gaps[0];
  if (g) watch.push({ code: 'GAP', params: { role: g.role, from: g.from, to: g.to, short: g.short, date: planDate } });
  if (forecast && forecast.usual > 0 && Math.abs(forecast.orders / forecast.usual - 1) >= 0.1) watch.push({ code: 'DEMAND', params: { pct: Math.round((forecast.orders / forecast.usual - 1) * 100), factor: forecast.reasons[0]?.factor ?? '' } });
  if (forecast?.peakHour !== undefined) watch.push({ code: 'PEAK', params: { hour: forecast.peakHour, orders: forecast.peakOrders ?? 0 } });
  for (const h of s.aiHealth?.models ?? []) if (h.status === 'DRIFT' || h.status === 'PAUSED') watch.push({ code: 'AI_HEALTH', params: { model: h.id, status: h.status, ...(h.cause ? { cause: h.cause } : {}) } });
  if (inbound.trucks > inbound.arrived) watch.push({ code: 'INBOUND', params: { trucks: inbound.trucks - inbound.arrived, cases: inbound.cases } });
  for (const g2 of skillGaps(st, s, planDate, ai.context?.hours ?? [])) watch.push({ code: 'SKILL_GAP', params: { skill: g2.skill, from: g2.from, to: g2.to, ...(g2.train ? { train: g2.train } : {}) } });

  // 需要店长决定的事
  const decisions: BriefItem[] = [];
  const byModule = new Map<string, number>();
  for (const r of openRecs) if (r.action.kind !== 'INFO' || r.action.params?.nudge === true) byModule.set(r.module, (byModule.get(r.module) ?? 0) + 1);
  for (const [module, count] of [...byModule.entries()].sort((a, b) => b[1] - a[1])) decisions.push({ code: 'RECS', params: { module, count } });
  if (staffing.pendingOffers) decisions.push({ code: 'OFFERS', params: { count: staffing.pendingOffers } });
  for (const [m, ms] of Object.entries(s.aiModes)) if (ms?.auto && ms.mode === 'SHOW') decisions.push({ code: 'MODE_DOWNGRADED', params: { module: m, hitRate: ms.auto.hitRate, n: ms.auto.n } });
  const dow = new Date(now).getDay();
  const nextWeek = weekOf(dateOf(dayStart(today) + 7 * DAY + 2 * 3_600_000));
  if ((dow === 0 || dow >= 4) && !s.schedules?.[nextWeek]) decisions.push({ code: 'PUBLISH_SCHEDULE', params: { week: nextWeek, from: dateInWeek(nextWeek, 0) } });

  return { at: now, part, date: today, ...(forecast ? { forecast } : {}), ...(soFar ? { soFar } : {}), inbound, staffing, ...(stats ? { stats } : {}), watch: watch.slice(0, 3), decisions: decisions.slice(0, 5) };
}
