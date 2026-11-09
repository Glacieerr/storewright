import { kpi } from '../analysis/kpi';
import { defaultFacilities } from '../facility/config';
import { currentFacilities, setFacilities } from '../facility/state';
import { mergeFacilities, parseClock } from '../scenario/parse';
import type { Scenario } from '../scenario/types';
import { buildBoard, type Board, type Issue } from '../sim/board';
import { scenarioFor } from '../sim/config';
import { allocationHour, emptyDay } from '../sim/plan';
import type { CheckItem, CheckResult, Exercise, ExerciseQuestion, ExerciseTask, TeachRun, TeachState } from './types';

/**
 * 练习的工具：按一次仿真重排调度台（只用场景里的设置，不含调度台上手动改的时刻，所以网页和命令行批改一样）、
 * 读指标、比对答案、组装批改结果。网页（练习面板）和命令行（npm run teach）都用这里，浏览器里也能跑（不跑仿真）。
 * Exercise helpers shared by the web panel and the CLI grader (no simulation here).
 */
export const PASS_RATIO = 0.7;

const boards = new WeakMap<object, Board>();

/** 这次仿真动画那一天的调度台（按这次的设施配置排门；排完把全局的设施配置恢复原样） */
export function boardOf(run: TeachRun): Board {
  const hit = boards.get(run.result);
  if (hit) return hit;
  const s = run.scenario;
  const sc = scenarioFor(s.gen ?? 'g3', s.seed ?? 1);
  const saved = currentFacilities();
  setFacilities(mergeFacilities(defaultFacilities(), s.facilities));
  try {
    const b = buildBoard(run.result.trace?.ops ?? [], emptyDay(), { allocation: allocationHour(sc), crossDock: sc.dc.crossDock });
    boards.set(run.result, b);
    return b;
  } finally {
    setFacilities(saved);
  }
}

/** 学生现在的那次仿真 */
export const current = (s: TeachState): TeachRun => ({ scenario: s.scenario, result: s.result, kpi: s.kpi });
/** 练习起始场景那次（没给就用现在的） */
export const base = (s: TeachState): TeachRun => (s.baseline ? { scenario: s.baseline.scenario, result: s.baseline.result, kpi: s.baseline.kpi } : current(s));
/** 对照场景 */
export function variant(s: TeachState, key: string): TeachRun {
  const v = s.variants?.[key];
  if (!v) throw new Error(`练习的对照场景 ${key} 没有跑（批改前要先跑 Exercise.variants）`);
  return v;
}

/** 指标面板里的一个指标（src/analysis/kpi.ts 的 key），按面板上显示的小数位取整 */
export function val(run: TeachRun, key: string): number {
  const k = kpi(key);
  const d = k.digits ?? 1;
  return Math.round(k.get(run.result) * 10 ** d) / 10 ** d;
}

/** 调度台的 KPI（按场景重排） */
export const dayKpi = (run: TeachRun) => boardOf(run).kpi;

/** 调度台「问题」里某几类的条数；group 只数冷链（C 门）或干货（D 门）的门问题 */
export function issueCount(run: TeachRun, codes: readonly Issue['code'][], group?: 'cold' | 'dry'): number {
  return boardOf(run).issues.filter(
    (i) => codes.includes(i.code) && (!group || (group === 'cold' ? /冷链/.test(i.text + i.title) : /干货/.test(i.text + i.title))),
  ).length;
}

/** 「到店准点」：调度台的瓦片（一位小数） */
export function onTimePct(run: TeachRun): number {
  const k = dayKpi(run);
  return Math.round((k.stops ? (k.onTime / k.stops) * 100 : 100) * 10) / 10;
}

/** 学生填的数字：去掉千分位、单位、百分号；填不出来返回 undefined */
export function parseNum(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const m = /[-−]?\d+(?:[.,]\d+)?/.exec(v.replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/\s+/g, ''));
  if (!m) return undefined;
  const n = Number(m[0].replace('−', '-').replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

/** 文字答案：大小写、空格、全角都不计较 */
export const normText = (v: unknown): string =>
  String(v ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toUpperCase();

export interface QSpec extends ExerciseQuestion {
  points: number;
  /** 数字题的容差（绝对值）；时刻题按分钟 */
  tol?: number;
  /** 'time'：text 题按 HH:MM 比 */
  format?: 'time';
  expect(s: TeachState): number | string;
  hint: string;
  hintEn: string;
}
export interface TaskSpec extends ExerciseTask {
  ok(s: TeachState): boolean;
  hint: string;
  hintEn: string;
}

const fmtAnswer = (q: QSpec, v: number | string): string => {
  if (typeof v === 'string') return q.kind === 'choice' ? `${v}（${q.choices?.find((c) => c.id === v)?.text ?? ''}）` : v;
  return String(Math.round(v * 1000) / 1000);
};

/** 一道题对不对 */
export function answerOk(q: QSpec, want: number | string, got: unknown): boolean {
  if (got === undefined || got === '') return false;
  if (q.kind === 'choice') return normText(got) === normText(want);
  if (q.format === 'time') {
    const a = parseClock(String(got).trim());
    const b = parseClock(String(want));
    return a !== undefined && b !== undefined && Math.abs(a - b) <= (q.tol ?? 1) * 60;
  }
  if (q.kind === 'text') return normText(got) === normText(want);
  const n = parseNum(got);
  return n !== undefined && typeof want === 'number' && Math.abs(n - want) <= (q.tol ?? 0) + 1e-9;
}

/** 题目单位的英文 */
const UNIT_EN: Record<string, string> = {
  天: 'days',
  '%': '%',
  美元: 'USD',
  '美元 / 天': 'USD / day',
  辆: 'vehicles',
  樘: 'doors',
  条: 'issues',
  个: 'docks',
  个百分点: 'percentage points',
  分钟: 'min',
};

const SPECS = new Map<string, readonly QSpec[]>();
/** 一道练习的题目定义（分值、容差；参考答案表用） */
export const specsOf = (id: string): readonly QSpec[] => SPECS.get(id) ?? [];

/** 按题目和任务组装一道练习的批改和参考答案 */
export function defineExercise(
  def: Omit<Exercise, 'check' | 'key' | 'questions' | 'tasks' | 'solution'> & {
    questions: QSpec[];
    tasks?: TaskSpec[];
    solution?: (s: TeachState) => Scenario;
  },
): Exercise {
  SPECS.set(def.id, def.questions);
  const check = (s: TeachState): CheckResult => {
    const items: CheckItem[] = [];
    for (const t of def.tasks ?? []) {
      let ok: boolean;
      try {
        ok = t.ok(s);
      } catch {
        ok = false;
      }
      items.push({
        id: t.id,
        ok,
        points: ok ? t.points : 0,
        text: ok ? `✓ ${t.text}` : `✗ ${t.text}：${t.hint}`,
        textEn: ok ? `✓ ${t.textEn}` : `✗ ${t.textEn}: ${t.hintEn}`,
      });
    }
    for (const q of def.questions) {
      const want = q.expect(s);
      const ok = answerOk(q, want, s.answers[q.id]);
      items.push({
        id: q.id,
        ok,
        points: ok ? q.points : 0,
        text: ok ? `✓ ${q.prompt}` : `✗ ${q.prompt}：${q.hint}`,
        textEn: ok ? `✓ ${q.promptEn}` : `✗ ${q.promptEn}: ${q.hintEn}`,
      });
    }
    const max = [...(def.tasks ?? []), ...def.questions].reduce((a, x) => a + x.points, 0);
    const score = items.reduce((a, x) => a + x.points, 0);
    return { passed: score >= max * PASS_RATIO, score, max, items };
  };
  const key = (s: TeachState) => [
    ...(def.tasks ?? []).map((t) => ({ id: t.id, answer: `（设置任务）${t.text}` })),
    ...def.questions.map((q) => ({ id: q.id, answer: fmtAnswer(q, q.expect(s)) })),
  ];
  const questions: ExerciseQuestion[] = def.questions.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    promptEn: q.promptEn,
    kind: q.kind,
    ...(q.choices ? { choices: q.choices } : {}),
    ...(q.unit ? { unit: q.unit, unitEn: q.unitEn ?? UNIT_EN[q.unit] ?? q.unit } : {}),
  }));
  const tasks: ExerciseTask[] | undefined = def.tasks?.map((t) => ({ id: t.id, text: t.text, textEn: t.textEn, points: t.points }));
  return { ...def, questions, ...(tasks ? { tasks } : {}), check, key, solution: def.solution ?? (() => def.scenario) };
}

/** 场景里某个设施的人员排班（没改就是默认） */
export function crewIn(s: Scenario, fac: 'port' | 'airport' | 'dc' | 'store', role: string): { early: number; late: number; night: number } | undefined {
  const f = mergeFacilities(defaultFacilities(), s.facilities);
  return (f[fac].staff as { key: string; crew: { early: number; late: number; night: number } }[]).find((r) => r.key === role)?.crew;
}

/** 场景里的设施配置（合并到默认值上） */
export const facOf = (s: Scenario) => mergeFacilities(defaultFacilities(), s.facilities);

/** 场景的方案、负荷、演练是不是和要求一样（没写的按默认） */
export function sameSetup(s: Scenario, want: Scenario): boolean {
  return (
    (s.gen ?? 'g3') === (want.gen ?? 'g3') &&
    (s.load ?? 'normal') === (want.load ?? 'normal') &&
    (s.drill ?? 'none') === (want.drill ?? 'none') &&
    (s.seed ?? 1) === (want.seed ?? 1) &&
    (s.region ?? 'default') === (want.region ?? 'default')
  );
}
