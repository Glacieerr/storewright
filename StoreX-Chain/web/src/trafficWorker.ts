import { regionSpecFrom } from '../../src/region/regionGen';
import type { Facilities } from '../../src/facility/config';
import { setFacilities } from '../../src/facility/state';
import { buildCity } from './three/regionCity';
import { TrafficPlanner, trafficTransfer, type TruckRun } from './three/traffic';
import { pedTransfer, planPeds } from './three/peds';

/**
 * 社会车流的后台线程：按网页的区域和设施配置重建同一套道路网和停车场，算一整天的车流（几千辆车的轨迹、公交线路），
 * 打包传回主线程播放。算一次要一两秒，放在这里算主线程不卡。
 */
export interface TrafficRequest {
  id: number;
  /** 网页地址里的 ?region=（没有就是默认区域） */
  region: string | null;
  facilities?: Facilities;
  trips: number;
  /** 每个钟点的天气车速系数（0–24 点；没有就是晴天） */
  weather?: number[];
  /** 当天的仿真车在路上的每一段行驶（背景车让它们：跟在后面、红灯前排在后面） */
  trucks?: TruckRun[];
}

self.onmessage = (e: MessageEvent<TrafficRequest>) => {
  const { id, region, facilities, trips, weather, trucks } = e.data;
  try {
    // 和 world.ts 同一个顺序（cityplan.ts）：停靠地点、停车场、小街、小区停车场，再收尾；场地登记表先清空，结果只看区域写法和设施配置
    const {
      net,
      plan: { lots },
    } = buildCity(regionSpecFrom(region), () => {
      if (facilities) setFacilities(facilities);
    });
    const tr = new TrafficPlanner(net);
    tr.simulate(trips, undefined, weather, trucks);
    // 行人：按算好的车流找过街的空当、按公交停靠上下车、按停车的车走到场口
    const peds = planPeds({ net, traffic: tr, crosswalks: tr.crosswalks(), lots, density: Math.sqrt(trips / 9000) });
    const data = tr.data();
    (self as unknown as Worker).postMessage({ id, data, peds }, [...trafficTransfer(data), ...pedTransfer(peds)]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err instanceof Error ? (err.stack ?? err.message) : err) });
  }
};
