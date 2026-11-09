import { setRegion } from '../../../src/region/network';
import type { RegionSpec } from '../../../src/region/regionGen';
import { clearSimVisits, clearYardSites } from '@storewright/yard';
import { layoutCity } from './cityplan';
import { RoadNet } from './roadnet';

/**
 * 按区域的写法从头搭一座城（道路网、停靠地点、停车场、小街、小区停车场），结果只看区域写法（和 before 里套上的设施配置）。
 * 收货场、物流园、机场、港口的场地布置和当天的访问登记在 @storewright/yard（packages/yard）的全局表里、按场地的键存：搭别的区域会把同一个键换成
 * 那个区域的场地，那个区域多出来的键、运动规划补登记的仿真车访问也不会自己清掉，所以先清空再搭。
 * 运动规划（motion.ts）按全局表里的场地算，所以搭好的道路网只在下一次搭别的区域之前有效：换了区域要重新搭，不拿旧的接着用。
 */
export function buildCity(spec: RegionSpec, before?: () => void): { net: RoadNet; plan: ReturnType<typeof layoutCity> } {
  setRegion(spec);
  before?.();
  clearYardSites();
  clearSimVisits();
  const net = new RoadNet();
  const plan = layoutCity(net);
  return { net, plan };
}
