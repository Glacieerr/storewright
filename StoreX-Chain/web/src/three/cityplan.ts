import { planHomeLots, planLots, type Lot } from './parking';
import { registerPlaces } from './places';
import type { RoadNet } from './roadnet';
import type { Site } from './stores';
import { TrafficPlanner } from './traffic';
import { planCurbs, planStreets, planZoning, type StreetPlan, type ZonePlan } from './zoning';

/**
 * 道路网收尾之前要摆的东西，按固定的顺序：车辆停靠的地点 → 各区域的停车场 → 城区分区 →（先收一次尾，排公交站）→ 小街 → 小区停车场 → 路口收尾。
 * 网页（world.ts）、社会车流的后台线程（trafficWorker.ts）和测试都调这一个函数，道路网一模一样（车流线程算的轨迹才对得上画面）。
 */
export interface CityPlan {
  sites: Map<string, Site>;
  /** 所有停车场（含小区停车场），和 net.lots 一样 */
  lots: Lot[];
  zplan: ZonePlan;
  streets: StreetPlan;
}

export function layoutCity(net: RoadNet): CityPlan {
  const sites = registerPlaces(net);
  const lots = planLots(net, sites);
  const zplan = planZoning(net, sites, lots.map((l) => l.outline));
  // 公交线路的站先在没有小街的路网上排一遍：小街接到干道上的路口让开这些站的港湾（首末站要的路段长，挤短了线路就跑不过来）
  net.finalize();
  const busy = new TrafficPlanner(net).busStops.map((st) => {
    const room = st.terminal ? 45 : 30;
    return { line: st.line, s0: st.s - st.g - room - 15, s1: st.s + st.g + room + 15 };
  });
  const streets = planStreets(net, zplan, busy);
  // 小区停车场摆好以后也不能盖房
  for (const l of planHomeLots(net, sites, streets.lines)) zplan.addArea(l.outline, 10);
  net.finalize();
  // 小街路边的停车位（要用路口退让的距离，收尾以后划）
  planCurbs(net);
  return { sites, lots: net.lots, zplan, streets };
}
