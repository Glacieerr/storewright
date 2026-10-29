import type { Role } from './day';
import type { Season } from './deliveries';

/**
 * 学生兼职工（决策记录 0020）：不能按全职的时长工作。规则是假设参数，参照常见的在校生兼职做法：
 * - 上学日（周一到周五，暑假除外）放学后才能来：16:00–21:00 之间，每天最多 4 小时；
 * - 周末和暑假：9:00–20:00 之间，每天最多 6 小时；
 * - 每周不超过 20 小时，所以不是每天都来：学期里每周来 4 天（3 个上学日 + 1 个周末），暑假每周 3 天；
 * - 不排夜班、不排开门前的班（也不在营业时间以外）。
 * 学生按名单顺序轮流分到可以做的岗位；同一天的人错开上班时间，覆盖傍晚的高峰。
 */

export interface StudentPlan {
  /** 名单上的学生人数 */
  count: number;
  /** 可以做的岗位（按顺序轮流分配） */
  roles: readonly Role[];
}

export interface StudentShift {
  id: string;
  role: Role;
  /** 上岗、下岗（当天的秒数） */
  start: number;
  end: number;
}

export interface StudentDay {
  /** 星期几（0 = 周一） */
  weekday: number;
  season: Season;
  /** 营业时间（当天的秒数） */
  open: number;
  close: number;
}

export const STUDENT_RULES = {
  schoolDay: { from: 16, to: 21, maxHours: 4 },
  freeDay: { from: 9, to: 20, maxHours: 6 },
  weeklyMaxHours: 20,
} as const;

/** 这天是不是上学日（周一到周五；暑假没有上学日） */
export function isSchoolDay(weekday: number, season: Season): boolean {
  return season !== 'summer' && weekday >= 0 && weekday <= 4;
}

/** 第 i 个学生每周来哪几天（0 = 周一）：学期里 3 个上学日 + 1 个周末，暑假 3 天；按编号错开 */
export function studentDays(i: number, season: Season): number[] {
  if (season === 'summer') return [i % 7, (i + 2) % 7, (i + 4) % 7].sort((a, b) => a - b);
  return [i % 5, (i + 2) % 5, (i + 4) % 5, 5 + (i % 2)].sort((a, b) => a - b);
}

/** 当天来上班的学生和各自的班次 */
export function studentShifts(plan: StudentPlan, day: StudentDay): StudentShift[] {
  if (plan.count <= 0 || !plan.roles.length) return [];
  const rule = isSchoolDay(day.weekday, day.season) ? STUDENT_RULES.schoolDay : STUDENT_RULES.freeDay;
  const from = Math.max(rule.from * 3600, day.open);
  const to = Math.min(rule.to * 3600, day.close);
  const len = Math.min(rule.maxHours * 3600, to - from);
  if (len < 3600) return [];
  const out: StudentShift[] = [];
  // 当天来的人依次错开：上学日两拨（放学就来 / 晚一小时来），周末三拨（上午、中午、下午）
  const waves = rule === STUDENT_RULES.schoolDay ? 2 : 3;
  let k = 0;
  for (let i = 0; i < plan.count; i++) {
    if (!studentDays(i, day.season).includes(day.weekday)) continue;
    const wave = k % waves;
    const start = from + (waves > 1 ? ((to - from - len) * wave) / (waves - 1) : 0);
    out.push({ id: `S${String(i + 1).padStart(2, '0')}`, role: plan.roles[i % plan.roles.length] as Role, start: Math.round(start), end: Math.round(start + len) });
    k++;
  }
  return out;
}

/** 每个学生每周的工时（检查不超过上限） */
export function studentWeeklyHours(i: number, season: Season, open: number, close: number): number {
  return studentDays(i, season).reduce((h, weekday) => {
    const s = studentShifts({ count: i + 1, roles: ['pick'] }, { weekday, season, open, close }).find((x) => x.id === `S${String(i + 1).padStart(2, '0')}`);
    return h + (s ? (s.end - s.start) / 3600 : 0);
  }, 0);
}
