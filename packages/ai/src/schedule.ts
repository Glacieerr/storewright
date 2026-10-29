/**
 * 排班生成（决策记录 0022 · 第二批 D1）：同一周、每 30 分钟一格。
 *
 * 输入：各岗位每个半小时需要几个人（由订单量预测算出的工作量换算，后仓、补货、带班等按固定覆盖），
 * 员工的岗位和技能、可上班时间、雇佣类型（全职 / 兼职 / 学生）。
 * 硬约束（一条都不能违反，checkSchedule 检查）：
 * - 只排在员工的可上班时间里、只排他会做的岗位；
 * - 每天最多一个班，班长在最短和最长之间；两班之间至少休息 minRestH 小时；每周不超过 maxDaysPerWeek 天；
 * - 每周工时不超过雇佣类型的上限；学生（决策记录 0020）：上学日放学后 16–21 点最多 4 小时，周末和暑假 9–20 点最多 6 小时，每周 20 小时。
 * 目标：缺口（需要的人没排上）最小，其次是多排（排了用不上）、加班、不公平（周末和晚班轮流）。
 * 做法：贪心先补最大的缺口（每次选「能补最多缺口、目前工时最少」的人和班次），再逐个班次前后挪半小时做局部改进。
 * 几十人 × 7 天在浏览器里几百毫秒；只按技能和可上班时间排，不按个人效率排。
 */

export type Employment = 'FULL' | 'PART_TIME' | 'STUDENT';

export interface ScheduleAssociate {
  id: string;
  /** 主岗位 */
  role: string;
  /** 还会做的岗位（主岗位自动包含） */
  skills?: readonly string[];
  employment?: Employment;
  maxWeeklyHours?: number;
  /** 可上班时间（星期几：0 = 周一；分钟数）；没有时按门店营业时间 */
  availability?: ReadonlyArray<{ day: number; from: number; to: number }>;
}

export interface LaborRules {
  minShiftH: number;
  maxShiftH: number;
  minRestH: number;
  maxDaysPerWeek: number;
  weekly: Record<Employment, number>;
  student: { schoolDay: { from: number; to: number; maxH: number }; freeDay: { from: number; to: number; maxH: number } };
  season: 'term' | 'summer';
  /** 门店开门前、关门后可以排班的范围（小时） */
  open: { from: number; to: number };
}

export const DEFAULT_LABOR: LaborRules = {
  minShiftH: 3,
  maxShiftH: 9,
  minRestH: 10,
  maxDaysPerWeek: 5,
  weekly: { FULL: 40, PART_TIME: 28, STUDENT: 20 },
  // 与学生兼职工的规则一致（决策记录 0020）
  student: { schoolDay: { from: 16, to: 21, maxH: 4 }, freeDay: { from: 9, to: 20, maxH: 6 } },
  season: 'term',
  open: { from: 6, to: 22 },
};

export interface ScheduleDemand {
  day: number;
  role: string;
  /** 48 个半小时，每格需要的人数 */
  slots: number[];
}

export interface ScheduleShift {
  associateId: string;
  day: number;
  /** 当天的分钟数 */
  from: number;
  to: number;
  role: string;
}

export type GapWhy = 'NO_ONE_AVAILABLE' | 'WEEKLY_LIMIT' | 'NO_SKILL';

export interface ScheduleGap {
  day: number;
  role: string;
  from: number;
  to: number;
  /** 这段时间平均缺几人 */
  heads: number;
  why: GapWhy;
}

export interface ScheduleResult {
  shifts: ScheduleShift[];
  /** 每天、每个岗位、每个半小时排了几人 */
  cover: Record<number, Record<string, number[]>>;
  gaps: ScheduleGap[];
  metrics: {
    /** 缺口、多排的人时；总工时 */
    underHours: number;
    overHours: number;
    totalHours: number;
    hoursBy: Record<string, number>;
    /** 全职员工的周末班、晚班（21 点以后下班）次数的最大差 */
    weekendSpread: number;
    eveningSpread: number;
    /** 违反的硬约束（应为空） */
    violations: string[];
  };
}

const SLOT = 30;
const SLOTS = 48;

export function laborRules(r: Partial<LaborRules> = {}): LaborRules {
  return { ...DEFAULT_LABOR, ...r, weekly: { ...DEFAULT_LABOR.weekly, ...(r.weekly ?? {}) }, student: { ...DEFAULT_LABOR.student, ...(r.student ?? {}) }, open: { ...DEFAULT_LABOR.open, ...(r.open ?? {}) } };
}

const skillsOf = (a: ScheduleAssociate) => new Set([a.role, ...(a.skills ?? [])]);
const employmentOf = (a: ScheduleAssociate): Employment => a.employment ?? 'FULL';
const weeklyCap = (a: ScheduleAssociate, r: LaborRules) => Math.min(a.maxWeeklyHours ?? Infinity, r.weekly[employmentOf(a)]) * 60;
const isSchoolDay = (day: number, r: LaborRules) => r.season !== 'summer' && day >= 0 && day <= 4;

/** 某人某天可以上班的时间窗（分钟）与当天最长班长 */
export function windowsFor(a: ScheduleAssociate, day: number, r: LaborRules): { windows: Array<[number, number]>; maxMin: number } {
  let windows: Array<[number, number]> = a.availability ? a.availability.filter((w) => w.day === day).map((w) => [w.from, w.to] as [number, number]) : [[r.open.from * 60, r.open.to * 60]];
  let maxMin = r.maxShiftH * 60;
  if (employmentOf(a) === 'STUDENT') {
    const rule = isSchoolDay(day, r) ? r.student.schoolDay : r.student.freeDay;
    windows = windows.map(([f, t]) => [Math.max(f, rule.from * 60), Math.min(t, rule.to * 60)] as [number, number]).filter(([f, t]) => t > f);
    maxMin = Math.min(maxMin, rule.maxH * 60);
  }
  return { windows, maxMin };
}

interface Plan {
  shifts: ScheduleShift[];
  byPerson: Map<string, ScheduleShift[]>;
  minutes: Map<string, number>;
}

function canTake(a: ScheduleAssociate, day: number, from: number, to: number, role: string, plan: Plan, r: LaborRules, ignore?: ScheduleShift): GapWhy | 'OK' {
  if (!skillsOf(a).has(role)) return 'NO_SKILL';
  const mine = (plan.byPerson.get(a.id) ?? []).filter((s) => s !== ignore);
  if (mine.some((s) => s.day === day)) return 'NO_ONE_AVAILABLE';
  if (mine.length >= r.maxDaysPerWeek) return 'NO_ONE_AVAILABLE';
  const { windows, maxMin } = windowsFor(a, day, r);
  const len = to - from;
  if (len < r.minShiftH * 60 - 1e-9 || len > maxMin + 1e-9) return 'NO_ONE_AVAILABLE';
  if (!windows.some(([f, t]) => from >= f && to <= t)) return 'NO_ONE_AVAILABLE';
  const rest = r.minRestH * 60;
  for (const s of mine) {
    if (s.day === day - 1 && from + 1440 - s.to < rest) return 'NO_ONE_AVAILABLE';
    if (s.day === day + 1 && s.from + 1440 - to < rest) return 'NO_ONE_AVAILABLE';
  }
  const used = mine.reduce((n, s) => n + (s.to - s.from), 0);
  if (used + len > weeklyCap(a, r) + 1e-9) return 'WEEKLY_LIMIT';
  return 'OK';
}

function emptyCover(demand: readonly ScheduleDemand[]): Record<number, Record<string, number[]>> {
  const cover: Record<number, Record<string, number[]>> = {};
  for (const d of demand) ((cover[d.day] ??= {})[d.role] ??= new Array<number>(SLOTS).fill(0));
  return cover;
}

function coverOf(shifts: readonly ScheduleShift[], demand: readonly ScheduleDemand[]): Record<number, Record<string, number[]>> {
  const cover = emptyCover(demand);
  for (const s of shifts) {
    const row = ((cover[s.day] ??= {})[s.role] ??= new Array<number>(SLOTS).fill(0));
    for (let k = Math.floor(s.from / SLOT); k < Math.ceil(s.to / SLOT); k++) row[k] = (row[k] ?? 0) + 1;
  }
  return cover;
}

export function generateSchedule(input: { associates: readonly ScheduleAssociate[]; demand: readonly ScheduleDemand[]; rules?: Partial<LaborRules> }): ScheduleResult {
  const r = laborRules(input.rules);
  const demand = input.demand;
  const need = new Map(demand.map((d) => [`${d.day}|${d.role}`, d.slots]));
  const plan: Plan = { shifts: [], byPerson: new Map(), minutes: new Map() };
  const cover = emptyCover(demand);
  const add = (s: ScheduleShift) => {
    plan.shifts.push(s);
    plan.byPerson.set(s.associateId, [...(plan.byPerson.get(s.associateId) ?? []), s]);
    plan.minutes.set(s.associateId, (plan.minutes.get(s.associateId) ?? 0) + s.to - s.from);
    const row = ((cover[s.day] ??= {})[s.role] ??= new Array<number>(SLOTS).fill(0));
    for (let k = Math.floor(s.from / SLOT); k < Math.ceil(s.to / SLOT); k++) row[k] = (row[k] ?? 0) + 1;
  };
  const deficit = (day: number, role: string, k: number) => ((need.get(`${day}|${role}`)?.[k] ?? 0) - (cover[day]?.[role]?.[k] ?? 0));
  const weekendCount = new Map<string, number>();
  const blocked = new Set<string>();
  const gaps: ScheduleGap[] = [];
  for (let iter = 0; iter < 2000; iter++) {
    // 最大的缺口
    let best: { day: number; role: string; k: number; d: number } | undefined;
    for (const dm of demand)
      for (let k = 0; k < SLOTS; k++) {
        const d = deficit(dm.day, dm.role, k);
        if (d > 0 && !blocked.has(`${dm.day}|${dm.role}|${k}`) && (!best || d > best.d)) best = { day: dm.day, role: dm.role, k, d };
      }
    if (!best) break;
    const { day, role } = best;
    // 缺口所在的连续时段
    let s0 = best.k;
    let s1 = best.k + 1;
    while (s0 > 0 && deficit(day, role, s0 - 1) > 0) s0--;
    while (s1 < SLOTS && deficit(day, role, s1) > 0) s1++;
    let choice: { a: ScheduleAssociate; from: number; to: number; score: number } | undefined;
    let why: GapWhy = 'NO_SKILL';
    for (const a of input.associates) {
      if (!skillsOf(a).has(role)) continue;
      const { windows, maxMin } = windowsFor(a, day, r);
      for (const [wf, wt] of windows) {
        const lenMax = Math.min(maxMin, wt - wf);
        if (lenMax < r.minShiftH * 60) continue;
        // 班长：至少最短班长，最多能覆盖这段缺口
        const len = Math.max(r.minShiftH * 60, Math.min(lenMax, (s1 - s0) * SLOT));
        // 在时间窗里滑动起点，让这个班盖住最多缺口
        for (let from = Math.max(wf, s0 * SLOT - len + SLOT); from + len <= wt && from <= s1 * SLOT - SLOT; from += SLOT) {
          const to = from + len;
          const ok = canTake(a, day, from, to, role, plan, r);
          if (ok !== 'OK') {
            if (ok === 'WEEKLY_LIMIT' || (ok === 'NO_ONE_AVAILABLE' && why === 'NO_SKILL')) why = ok;
            continue;
          }
          let gain = 0;
          let over = 0;
          for (let k = Math.floor(from / SLOT); k < to / SLOT; k++) {
            if (deficit(day, role, k) > 0) gain++;
            else over++;
          }
          if (!gain) continue;
          const fairness = (plan.minutes.get(a.id) ?? 0) / Math.max(60, weeklyCap(a, r));
          const weekend = day >= 5 ? (weekendCount.get(a.id) ?? 0) * 0.6 : 0;
          const score = gain - 0.35 * over + (a.role === role ? 0.8 : 0) - 2 * fairness - weekend;
          if (!choice || score > choice.score) choice = { a, from, to, score };
        }
      }
    }
    if (!choice) {
      for (let k = s0; k < s1; k++) blocked.add(`${day}|${role}|${k}`);
      let heads = 0;
      for (let k = s0; k < s1; k++) heads += Math.max(0, deficit(day, role, k));
      gaps.push({ day, role, from: s0 * SLOT, to: s1 * SLOT, heads: Math.round((heads / (s1 - s0)) * 10) / 10, why });
      continue;
    }
    add({ associateId: choice.a.id, day, from: choice.from, to: choice.to, role });
    if (day >= 5) weekendCount.set(choice.a.id, (weekendCount.get(choice.a.id) ?? 0) + 1);
  }
  // 局部改进：每个班次前后挪半小时（不违反约束、净改善为正才接受）
  const cost = (s: ScheduleShift, from: number, to: number) => {
    let c = 0;
    for (let k = Math.floor(from / SLOT); k < to / SLOT; k++) {
      const others = (cover[s.day]?.[s.role]?.[k] ?? 0) - (k >= Math.floor(s.from / SLOT) && k < s.to / SLOT ? 1 : 0);
      c += others + 1 > (need.get(`${s.day}|${s.role}`)?.[k] ?? 0) ? 0.35 : -1;
    }
    return c;
  };
  for (let pass = 0; pass < 2; pass++) {
    for (const s of plan.shifts) {
      const a = input.associates.find((x) => x.id === s.associateId);
      if (!a) continue;
      const tries: Array<[number, number]> = [
        [s.from - SLOT, s.to - SLOT],
        [s.from + SLOT, s.to + SLOT],
        [s.from, s.to - SLOT],
        [s.from + SLOT, s.to],
        [s.from - SLOT, s.to],
        [s.from, s.to + SLOT],
      ];
      let bestTry: [number, number] | undefined;
      let bestCost = cost(s, s.from, s.to);
      for (const [f, t] of tries) {
        if (f < 0 || t > 1440 || canTake(a, s.day, f, t, s.role, plan, r, s) !== 'OK') continue;
        const c = cost(s, f, t);
        if (c < bestCost - 1e-9) {
          bestCost = c;
          bestTry = [f, t];
        }
      }
      if (!bestTry) continue;
      const row = cover[s.day]?.[s.role] as number[];
      for (let k = Math.floor(s.from / SLOT); k < s.to / SLOT; k++) row[k] = (row[k] ?? 0) - 1;
      plan.minutes.set(s.associateId, (plan.minutes.get(s.associateId) ?? 0) - (s.to - s.from) + (bestTry[1] - bestTry[0]));
      s.from = bestTry[0];
      s.to = bestTry[1];
      for (let k = Math.floor(s.from / SLOT); k < s.to / SLOT; k++) row[k] = (row[k] ?? 0) + 1;
    }
  }
  return summarize(plan.shifts, input.associates, demand, r, gaps);
}

function summarize(shifts: ScheduleShift[], associates: readonly ScheduleAssociate[], demand: readonly ScheduleDemand[], r: LaborRules, gaps: ScheduleGap[]): ScheduleResult {
  const cover = coverOf(shifts, demand);
  let under = 0;
  let over = 0;
  for (const d of demand)
    for (let k = 0; k < SLOTS; k++) {
      const c = cover[d.day]?.[d.role]?.[k] ?? 0;
      const n = d.slots[k] ?? 0;
      if (c < n) under += (n - c) * 0.5;
      else over += (c - n) * 0.5;
    }
  const hoursBy: Record<string, number> = {};
  for (const s of shifts) hoursBy[s.associateId] = Math.round(((hoursBy[s.associateId] ?? 0) + (s.to - s.from) / 60) * 10) / 10;
  const full = associates.filter((a) => employmentOf(a) === 'FULL');
  const spread = (pred: (s: ScheduleShift) => boolean) => {
    if (full.length < 2) return 0;
    const counts = full.map((a) => shifts.filter((s) => s.associateId === a.id && pred(s)).length);
    return Math.max(...counts) - Math.min(...counts);
  };
  return {
    shifts: [...shifts].sort((a, b) => a.day - b.day || a.from - b.from || a.associateId.localeCompare(b.associateId)),
    cover,
    gaps,
    metrics: {
      underHours: Math.round(under * 10) / 10,
      overHours: Math.round(over * 10) / 10,
      totalHours: Math.round((shifts.reduce((n, s) => n + s.to - s.from, 0) / 60) * 10) / 10,
      hoursBy,
      weekendSpread: spread((s) => s.day >= 5),
      eveningSpread: spread((s) => s.to >= 21 * 60),
      violations: checkSchedule(shifts, associates, r),
    },
  };
}

/** 改过的班表重新打分（决策记录 0026：带班负责人改了草稿以后，缺口、多排、工时和规则检查跟着变） */
export function scoreSchedule(shifts: readonly ScheduleShift[], associates: readonly ScheduleAssociate[], demand: readonly ScheduleDemand[], rules: Partial<LaborRules> = {}): Pick<ScheduleResult, 'cover' | 'metrics'> {
  const res = summarize([...shifts], associates, demand, laborRules(rules), []);
  return { cover: res.cover, metrics: res.metrics };
}

/** 检查硬约束：返回违反的条目（空数组表示全部满足） */
export function checkSchedule(shifts: readonly ScheduleShift[], associates: readonly ScheduleAssociate[], rules: Partial<LaborRules> = {}): string[] {
  const r = laborRules(rules);
  const out: string[] = [];
  const byId = new Map(associates.map((a) => [a.id, a]));
  const by = new Map<string, ScheduleShift[]>();
  for (const s of shifts) by.set(s.associateId, [...(by.get(s.associateId) ?? []), s]);
  for (const [id, list] of by) {
    const a = byId.get(id);
    if (!a) {
      out.push(`${id}: not on the roster`);
      continue;
    }
    const days = new Set<number>();
    let minutes = 0;
    for (const s of list) {
      if (days.has(s.day)) out.push(`${id}: two shifts on day ${s.day}`);
      days.add(s.day);
      minutes += s.to - s.from;
      if (!skillsOf(a).has(s.role)) out.push(`${id}: no skill ${s.role}`);
      const { windows, maxMin } = windowsFor(a, s.day, r);
      if (s.to - s.from < r.minShiftH * 60 - 1e-9) out.push(`${id}: shift shorter than ${r.minShiftH} h on day ${s.day}`);
      if (s.to - s.from > maxMin + 1e-9) out.push(`${id}: shift longer than allowed on day ${s.day}`);
      if (!windows.some(([f, t]) => s.from >= f && s.to <= t)) out.push(`${id}: outside availability on day ${s.day}`);
      for (const o of list) if (o.day === s.day + 1 && o.from + 1440 - s.to < r.minRestH * 60) out.push(`${id}: rest under ${r.minRestH} h between day ${s.day} and ${o.day}`);
    }
    if (days.size > r.maxDaysPerWeek) out.push(`${id}: more than ${r.maxDaysPerWeek} days`);
    if (minutes > weeklyCap(a, r) + 1e-9) out.push(`${id}: over the weekly limit`);
  }
  return out;
}

/**
 * 每小时的工作量（人分钟）→ 每个半小时需要的人数：按 85% 的有效工时换算后向上取整；
 * minHeads 是营业时间里每个小时至少要有的人数（例如交付区开门就要有人）。
 */
export function headsFromWorkload(workloadMin: readonly number[], opts: { efficiency?: number; minHeads?: number; hours?: readonly number[] } = {}): number[] {
  const eff = opts.efficiency ?? 0.85;
  const open = new Set(opts.hours ?? []);
  const slots = new Array<number>(SLOTS).fill(0);
  for (let h = 0; h < 24; h++) {
    const heads = Math.max(Math.ceil(((workloadMin[h] ?? 0) / (60 * eff)) - 0.15), open.has(h) ? (opts.minHeads ?? 0) : 0);
    slots[h * 2] = heads;
    slots[h * 2 + 1] = heads;
  }
  return slots;
}

/** 固定覆盖：from–to 点之间每个半小时 heads 人（后仓、补货、带班负责人等） */
export function fixedHeads(from: number, to: number, heads = 1): number[] {
  return Array.from({ length: SLOTS }, (_, k) => (k >= from * 2 && k < to * 2 ? heads : 0));
}

/**
 * 「手工排班」对照：每人按主岗位、在可上班时间里从最早开始排最长的班，直到每周上限
 * （很多门店的固定班表就是这样：不看每小时的工作量）。
 */
export function naiveSchedule(input: { associates: readonly ScheduleAssociate[]; demand: readonly ScheduleDemand[]; rules?: Partial<LaborRules> }): ScheduleResult {
  const r = laborRules(input.rules);
  const plan: Plan = { shifts: [], byPerson: new Map(), minutes: new Map() };
  for (const a of input.associates) {
    for (let day = 0; day < 7; day++) {
      const { windows, maxMin } = windowsFor(a, day, r);
      const w = windows[0];
      if (!w) continue;
      const len = Math.min(maxMin, w[1] - w[0], 8 * 60);
      const s: ScheduleShift = { associateId: a.id, day, from: w[0], to: w[0] + len, role: a.role };
      if (canTake(a, day, s.from, s.to, a.role, plan, r) !== 'OK') continue;
      plan.shifts.push(s);
      plan.byPerson.set(a.id, [...(plan.byPerson.get(a.id) ?? []), s]);
      plan.minutes.set(a.id, (plan.minutes.get(a.id) ?? 0) + len);
    }
  }
  return summarize(plan.shifts, input.associates, input.demand, r, []);
}
