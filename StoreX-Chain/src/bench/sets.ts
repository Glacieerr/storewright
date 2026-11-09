import { BLIND2_ACCEPT, BLIND3_ACCEPT, BLIND4_ACCEPT, type BlindAccept } from '../assistant/eval';
import { BLIND_SET, type BlindItem } from '../assistant/evalBlind';
import { BLIND_SET2 } from '../assistant/evalBlind2';
import { BLIND_SET3 } from '../assistant/evalBlind3';
import { BLIND_SET4 } from '../assistant/evalBlind4';
import { BLIND2_FIRST, BLIND3_FIRST, BLIND_FIRST } from '../cli/assistantEval';

/**
 * Duty-Desk Bench（值班台基准）的四套题：四个单独启动的 AI 出题代理（不是真人）各写 80 题，都没看过值班助手的代码、训练语料和别的题，原样收进来。
 * 每套的正式成绩是值班助手那一版第一次跑这套题的结果（跑完才看题、不按它改），之后再跑只是回归。
 * The four item sets of Duty-Desk Bench and the official (first-run) score of each.
 */
export const BENCH_NAME = 'Duty-Desk Bench';
export const BENCH_NAME_ZH = '值班台基准';
export const BENCH_ID = 'duty-desk-bench';
/** 基准本身的版本（题目、评分规则、评测时刻变了才加） */
export const BENCH_VERSION = '1.0';

export type SetKey = 'blind1' | 'blind2' | 'blind3' | 'blind4';
export const SET_KEYS: readonly SetKey[] = ['blind1', 'blind2', 'blind3', 'blind4'];

export interface Score {
  intent: number;
  tool: number;
  behavior: number;
  safety: number;
  all: number;
}

/** 第四套首次运行（第十轮，新分类器 + 没把握先问）：docs/results/assistant-eval.md 开头的表；跑完没有按第四套改过任何东西 */
export const BLIND4_FIRST: Score = { intent: 69, tool: 69, behavior: 67, safety: 80, all: 61 };

export interface BenchSet {
  key: SetKey;
  /** 题号前缀（B、C、D、E） */
  prefix: string;
  label: string;
  labelEn: string;
  items: readonly BlindItem[];
  /** 出题人说明里标为「也可以」、条件在评测数据里成立的做法 */
  accept: Record<string, BlindAccept>;
  /** 正式成绩：值班助手哪一版第一次跑（题数都是 80） */
  official: Score & { version: string; versionEn: string };
  /** 现在还算不算盲测（第一到第三套已经看过、修过问题） */
  stillBlind: boolean;
}

export const BENCH_SETS: readonly BenchSet[] = [
  {
    key: 'blind1',
    prefix: 'B',
    label: '第一套',
    labelEn: 'Set 1',
    items: BLIND_SET,
    accept: {},
    official: { ...BLIND_FIRST, version: 'v1：规则 + 朴素贝叶斯（改进前）', versionEn: 'v1: rules + naive Bayes (before improvements)' },
    stillBlind: false,
  },
  {
    key: 'blind2',
    prefix: 'C',
    label: '第二套',
    labelEn: 'Set 2',
    items: BLIND_SET2,
    accept: BLIND2_ACCEPT,
    official: { ...BLIND2_FIRST, version: 'v2：第一轮通用改进以后', versionEn: 'v2: after the first round of general improvements' },
    stillBlind: false,
  },
  {
    key: 'blind3',
    prefix: 'D',
    label: '第三套',
    labelEn: 'Set 3',
    items: BLIND_SET3,
    accept: BLIND3_ACCEPT,
    official: { ...BLIND3_FIRST, version: 'v3：重新训练以后', versionEn: 'v3: after retraining' },
    stillBlind: false,
  },
  {
    key: 'blind4',
    prefix: 'E',
    label: '第四套',
    labelEn: 'Set 4',
    items: BLIND_SET4,
    accept: BLIND4_ACCEPT,
    official: { ...BLIND4_FIRST, version: 'v4：逻辑回归 + 没把握先问', versionEn: 'v4: logistic regression + ask when unsure' },
    stillBlind: true,
  },
];

export const benchSet = (k: SetKey): BenchSet => BENCH_SETS.find((s) => s.key === k) as BenchSet;

/** 题号 → 哪一套 */
export function setOfItem(id: string): BenchSet | undefined {
  return BENCH_SETS.find((s) => s.items.some((x) => x.id === id));
}

/** --set 参数：all 或 blind1–blind4（也认 1–4、set4） */
export function parseSets(v: string | undefined): SetKey[] {
  if (!v || v === 'all') return [...SET_KEYS];
  return v.split(',').map((x) => {
    const m = /^(?:blind|set)?([1-4])$/.exec(x.trim());
    if (!m) throw new Error(`不认识的题目套：${x}（可以写 all、blind1–blind4）`);
    return `blind${m[1]}` as SetKey;
  });
}
