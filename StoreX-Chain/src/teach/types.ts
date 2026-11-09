import type { Scenario } from '../scenario/types';
import type { ChainResult } from '../sim/engine';
import type { DayKpi } from '../sim/board';

/**
 * 教学沙盘的练习（运营教学沙盘：物流、供应链、工业工程课程用）。每道练习：一个起始场景 + 操作步骤 + 几道问题 + 自动批改。
 * 批改只看确定的东西（同样的场景、同样的种子，仿真结果每次一样），所以老师和学生在任何电脑上得到同一个分数。
 * 网页里的练习面板、命令行的批改（npm run teach）、测试都用这里的定义。
 *
 * Teaching-sandbox exercise: a starting scenario, steps, questions and a deterministic auto-check.
 */
export type ExerciseLevel = 'intro' | 'core' | 'advanced';

export interface ExerciseQuestion {
  id: string;
  prompt: string;
  promptEn: string;
  /** text 题可以是作业编号、时刻（HH:MM）等 */
  kind: 'number' | 'choice' | 'text';
  choices?: { id: string; text: string; textEn: string }[];
  /** 数字题的单位（显示用，中文 / 英文） */
  unit?: string;
  unitEn?: string;
}

/** 一次仿真：场景、结果（含动画那一天的轨迹）、调度台 KPI（可以不给，批改时按轨迹重算） */
export interface TeachRun {
  scenario: Scenario;
  result: ChainResult;
  kpi?: DayKpi;
}

/** 批改时拿到的东西：学生现在的设置、按这个设置跑出来的结果、练习起始场景的结果、对照场景的结果、学生填的答案 */
export interface TeachState {
  scenario: Scenario;
  result: ChainResult;
  /** 调度台按动画那一天算的 KPI */
  kpi: DayKpi;
  baseline?: { scenario: Scenario; result: ChainResult; kpi: DayKpi };
  /** 练习要的对照场景（Exercise.variants 列出的，按 key） */
  variants?: Record<string, TeachRun>;
  answers: Record<string, string | number>;
}

/** 「改设置」类的任务：学生要在界面里做到的事（批改看学生现在的场景和结果） */
export interface ExerciseTask {
  id: string;
  text: string;
  textEn: string;
  points: number;
}

export interface CheckItem {
  id: string;
  ok: boolean;
  /** 给学生看的说明（对 / 错在哪、提示），中文 / 英文 */
  text: string;
  textEn: string;
  points: number;
}

export interface CheckResult {
  passed: boolean;
  score: number;
  max: number;
  items: CheckItem[];
}

export interface Exercise {
  /** ex01 … ex10 */
  id: string;
  title: string;
  titleEn: string;
  level: ExerciseLevel;
  /** 大约要多少分钟 */
  minutes: number;
  /** 涉及的知识点（中文 / 英文） */
  topics: string[];
  topicsEn: string[];
  /** 学习目标 */
  goals: string;
  goalsEn: string;
  /** 起始场景（打开练习时套用） */
  scenario: Scenario;
  steps: { zh: string; en: string }[];
  questions: ExerciseQuestion[];
  /** 背景知识（练习面板和实验指导书显示） */
  background?: { zh: string; en: string };
  /** 课后讨论题（不批改） */
  think?: { zh: string; en: string }[];
  /** 要在界面里完成的设置任务（显示用；批改在 check 里） */
  tasks?: ExerciseTask[];
  /** 练习面板「读数」区要显示的指标（src/analysis/kpi.ts 的 key），和指标面板同一份数据 */
  readouts?: string[];
  /** 批改要的对照场景（由起始场景推出来；网页和命令行都会先跑完它们再批改） */
  variants?: (start: Scenario) => { key: string; scenario: Scenario }[];
  check(state: TeachState): CheckResult;
  /** 参考答案（教师用；从仿真结果算出来，和批改用的是同一份数）。state 要按 solution 的场景算 */
  key?(state: TeachState): { id: string; answer: string }[];
  /** 做完设置任务以后应有的场景（参考答案和测试用；state 是按起始场景算的，含对照场景） */
  solution?(state: TeachState): Scenario;
}
