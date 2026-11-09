import { chainScenarioOf } from '../scenario/sim';
import type { Scenario } from '../scenario/types';
import { buildBoard } from '../sim/board';
import { runChain } from '../sim/engine';
import { allocationHour, emptyDay } from '../sim/plan';
import type { Exercise, TeachRun, TeachState } from './types';

/**
 * 在 Node 里跑练习要的仿真（命令行批改、参考答案、测试用；网页在后台线程里跑同样的东西）。
 * Runs the simulations an exercise needs, in Node (CLI grader, answer key, tests).
 */
export function runScenario(s: Scenario): Required<TeachRun> {
  const sc = chainScenarioOf(s);
  const result = runChain(sc);
  const kpi = buildBoard(result.trace?.ops ?? [], emptyDay(), { allocation: allocationHour(sc), crossDock: sc.dc.crossDock }).kpi;
  return { scenario: s, result, kpi };
}

/** 批改要的全部东西：学生的场景、练习起始场景、对照场景都跑一遍（同一个场景只跑一次） */
export function teachStateFor(ex: Exercise, scenario: Scenario, answers: Record<string, string | number>): TeachState {
  const memo = new Map<string, Required<TeachRun>>();
  const run = (s: Scenario) => {
    const k = JSON.stringify({
      ...s,
      title: undefined,
      titleEn: undefined,
      description: undefined,
      descriptionEn: undefined,
      time: undefined,
      camera: undefined,
      play: undefined,
      speed: undefined,
      follow: undefined,
      exercise: undefined,
      tour: undefined,
      tab: undefined,
      weather: undefined,
    });
    let r = memo.get(k);
    if (!r) memo.set(k, (r = runScenario(s)));
    return r;
  };
  const variants = Object.fromEntries((ex.variants?.(ex.scenario) ?? []).map((v) => [v.key, run(v.scenario)]));
  const b = run(ex.scenario);
  const cur = run(scenario);
  return { scenario, result: cur.result, kpi: cur.kpi, baseline: { scenario: ex.scenario, result: b.result, kpi: b.kpi }, variants, answers };
}
