import type { Scenario } from '../../src/scenario/types';
import type { TeachState } from '../../src/teach/types';

/**
 * 网页里各个面板之间的小接口（main.ts 实现并登记；演示导览、教学沙盘、新手导览这些独立的模块通过它和主程序打交道，
 * 不用直接改 main.ts 的内部）。
 * A small registry so feature modules (tour, teaching panel, onboarding) can talk to main.ts without reaching into it.
 */
export interface AppApi {
  /** 套用一个场景：换方案、种子、负荷、演练、设施就重新仿真；再设时刻、镜头、跟随、天气、页签（区域不同要重新载入页面） */
  applyScenario(s: Scenario): Promise<void>;
  /** 现在的设置写成场景（分享链接、导出场景文件、教学批改用） */
  currentScenario(): Scenario;
  /** 教学批改要的东西（还没仿真完返回 undefined）；baseline 是练习起始场景的结果（由调用方给出场景） */
  teachState(answers: Record<string, string | number>, start?: Scenario): Promise<TeachState | undefined>;
  /** 现在的时刻（秒） */
  time(): number;
}

let api: AppApi | undefined;
const waiters: ((a: AppApi) => void)[] = [];

export function setAppApi(a: AppApi): void {
  api = a;
  for (const w of waiters.splice(0)) w(a);
}

export const appApi = (): AppApi | undefined => api;

/** 等主程序登记好接口 */
export function whenApp(): Promise<AppApi> {
  return api ? Promise.resolve(api) : new Promise((r) => waiters.push(r));
}
