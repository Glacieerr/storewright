/// <reference lib="webworker" />
import { runChain } from '../../src/sim/engine';
import { scenarioFor, withLoad, type Gen, type LoadLevel } from '../../src/sim/config';
import { applyStanding, type StandingPlan } from '../../src/sim/plan';
import { TRACE_DAY } from '../../src/analysis/studies';
import { DRILL_START, DRILLS, type Drill } from './drills';
import { setRegion } from '../../src/region/network';
import type { RegionSpec } from '../../src/region/regionGen';
import { applyFacilities, type Facilities } from '../../src/facility/config';
import { currentFacilities, setFacilities } from '../../src/facility/state';

/** 全链路仿真在后台线程里跑（18 周、一家综合店的整条供应链，约 0.1–0.3 秒），记录第 TRACE_DAY 天的动画轨迹 */
export interface ChainRequest {
  id: number;
  gen: Gen;
  seed: number;
  drill: Drill;
  /** 负荷档位（不给 = 平常） */
  load?: LoadLevel;
  /** 区域（不给 = 默认区域） */
  region?: RegionSpec;
  /** 设施配置（管理台改过才传） */
  facilities?: Facilities;
  /** 调度台改过的常规计划（不给 = 默认计划） */
  standing?: StandingPlan;
  /** 当天调度：改过出发 / 到达时刻的作业 */
  day?: { depart: Record<string, number>; arrive: Record<string, number> };
}

self.onmessage = (e: MessageEvent<ChainRequest>) => {
  const { id, gen, seed, drill, standing, day, load, region, facilities } = e.data;
  try {
    if (region) setRegion(region);
    if (facilities) setFacilities(facilities);
    const t0 = performance.now();
    const s = applyFacilities(withLoad(scenarioFor(gen, seed), load ?? 'normal'), currentFacilities());
    s.traceDay = TRACE_DAY;
    if (standing) applyStanding(s, standing);
    if (day && (Object.keys(day.depart).length || Object.keys(day.arrive).length)) s.plan = day;
    if (drill !== 'none') {
      const c = DRILLS.find((x) => x.key === drill);
      s.disruption = { key: drill, start: DRILL_START[drill], days: c?.days ?? 1 };
    }
    const result = runChain(s);
    (self as unknown as Worker).postMessage({ id, result, ms: performance.now() - t0 });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
