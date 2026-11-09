/// <reference lib="webworker" />
import type { StoreLot } from '../../src/site/lot';
import { planSiteTraffic, stripPaths, type LotRoad, type LotTraffic } from '../../src/site/motion';
import type { People } from '../../src/site/people';
import type { StayPlan } from '../../src/site/stays';

/**
 * 综合店停车场的车流（时空预约，src/site/motion.ts）在后台线程排：一整天两三千辆车要排几秒，放在这里主线程不卡。
 * 收到停车场、车位安排和人，排完把每辆车的路线（只有怎么生成，不带算好的路径）传回去；主线程画的时候用到才生成。
 * 停不进原来车位、晚过顾客下车走开的车换了车位的，连同改过的车位安排和重排的人一起传回去。
 */
export interface SiteRequest {
  id: number;
  lot: StoreLot;
  plan: StayPlan;
  people: People;
  road: LotRoad;
  /** 人重排用的种子（和主线程排人的一样） */
  seed: number;
}
export interface SiteReply {
  id: number;
  res?: LotTraffic;
  /** 换过车位时：改过的车位安排、重排的人 */
  plan?: StayPlan;
  people?: People;
  ms?: number;
  error?: string;
}

self.onmessage = (e: MessageEvent<SiteRequest>) => {
  const { id, lot, plan, road, seed } = e.data;
  try {
    const t0 = performance.now();
    const r = planSiteTraffic(lot, plan, seed, road);
    const res = stripPaths(r.res);
    (self as unknown as Worker).postMessage({ id, res, ms: performance.now() - t0, ...(r.moved.length ? { plan, people: r.people } : {}) } satisfies SiteReply);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) } satisfies SiteReply);
  }
};
