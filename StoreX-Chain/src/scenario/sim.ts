import { STRESS, TRACE_DAY } from '../analysis/studies';
import { applyFacilities, defaultFacilities, type Facilities } from '../facility/config';
import { setFacilities } from '../facility/state';
import { setRegion } from '../region/network';
import { regionSpecFrom } from '../region/regionGen';
import { scenarioFor, withLoad, type ChainScenario } from '../sim/config';
import { DRILL_START } from './drill';
import { mergeFacilities } from './parse';
import type { Scenario } from './types';

/**
 * 场景 → 全链路仿真的参数（命令行、教学沙盘的自动批改、测试用；网页在后台线程里做同样的事）。
 * 会切换全局的区域和设施配置（和网页的后台线程一样），所以先调这个、再跑仿真。
 * Builds the chain-simulation input for a scenario (switches the global region and facility state, like the web worker).
 */

export { DRILL_START };

export function scenarioFacilities(s: Scenario): Facilities {
  return mergeFacilities(defaultFacilities(), s.facilities);
}

export function chainScenarioOf(s: Scenario, opts: { traceDay?: number } = {}): ChainScenario {
  setRegion(regionSpecFrom(s.region ?? 'default'));
  const fac = scenarioFacilities(s);
  setFacilities(fac);
  const sc = applyFacilities(withLoad(scenarioFor(s.gen ?? 'g3', s.seed ?? 1), s.load ?? 'normal'), fac);
  sc.traceDay = opts.traceDay ?? TRACE_DAY;
  const drill = s.drill ?? 'none';
  if (drill !== 'none') sc.disruption = { key: drill, start: DRILL_START[drill], days: STRESS.find((c) => c.key === drill)?.days ?? 1 };
  return sc;
}
