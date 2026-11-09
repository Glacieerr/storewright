import { BACKGROUND } from './background';
import { ALL_EXERCISES } from './exercises';
import type { Exercise } from './types';

export * from './types';
export { PASS_RATIO, boardOf, issueCount, parseNum, answerOk } from './lab';

/** 全部练习（按编号）：内容在 exercises.ts 里 */
export const EXERCISES: readonly Exercise[] = ALL_EXERCISES.map((ex) => ({ ...ex, ...(BACKGROUND[ex.id] ?? {}) }));

export const exerciseById = (id: string): Exercise | undefined => EXERCISES.find((e) => e.id === id);
