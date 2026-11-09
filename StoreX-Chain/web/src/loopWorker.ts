/// <reference lib="webworker" />
import type { Board } from '../../src/sim/board';
import type { WVehicle } from '../../src/sim/trace';
import type { DataQuality } from '../../src/twin/channel';
import type { FieldLevel } from '../../src/twin/field';
import { runLoop, type LoopInput } from '../../src/twin/loop';
import type { Policy, UserDecision } from '../../src/twin/types';
import { setRegion } from '../../src/region/network';
import type { RegionSpec } from '../../src/region/regionGen';
import type { Facilities } from '../../src/facility/config';
import { setFacilities } from '../../src/facility/state';

/**
 * 闭环孪生在后台线程里跑：同样的现场状况跑两遍（用孪生、不用孪生），一整天一分钟一步，各约零点二秒。
 * 计划（仿真那一天的车辆和作业、调度台排好的门和车）换了才传；调度员做了决定只重跑用孪生的那一遍。
 */
export interface LoopPlan {
  vehicles: WVehicle[];
  board: Board;
  store: { stock: Record<string, number>; demand: Record<string, number> };
  direct: string[];
}
export interface LoopRequest {
  id: number;
  plan?: LoopPlan;
  seed: number;
  level: FieldLevel;
  policy: Policy;
  decisions: UserDecision[];
  closedOnly?: boolean;
  /** 区域（和仿真用同一个，路线、里程才对得上） */
  region?: RegionSpec;
  /** 设施配置（门店收货口、开放的月台门） */
  facilities?: Facilities;
  /** 通信质量（数据到孪生之前丢点、晚到；不用孪生的那一遍不受影响） */
  quality?: DataQuality;
}

let plan: LoopPlan | undefined;
self.onmessage = (e: MessageEvent<LoopRequest>) => {
  const { id, seed, level, policy, decisions, closedOnly, region, facilities, quality } = e.data;
  try {
    if (region) setRegion(region);
    if (facilities) setFacilities(facilities);
    if (e.data.plan) plan = e.data.plan;
    if (!plan) throw new Error('没有计划');
    const t0 = performance.now();
    const input: LoopInput = { vehicles: plan.vehicles, ops: plan.board.ops, board: plan.board, seed, store: plan.store, direct: plan.direct, level };
    const closed = runLoop(input, { closed: true, policy, decisions, ...(quality ? { quality } : {}) });
    const open = closedOnly ? undefined : runLoop(input, { closed: false, policy: 'manual', decisions: [] });
    (self as unknown as Worker).postMessage({ id, closed, open, ms: performance.now() - t0 });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
