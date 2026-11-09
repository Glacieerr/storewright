/// <reference lib="webworker" />
import { runDay } from '../../../StoreX/src/ops/day';
import { gen1, storex } from '../../../StoreX/src/world/config';

/**
 * 综合店的门店仿真（StoreX 的离散事件仿真，一天约 1–2 秒）：区域场景拉近综合店时，店里的人和机器人按它回放。
 * 上一代用 Storewright 那一代的门店，StoreX 和全链路用 StoreX 门店。
 */
export interface StoreRequest {
  id: number;
  generation: 'gen1' | 'storex';
  seed: number;
}

self.onmessage = (e: MessageEvent<StoreRequest>) => {
  const { id, generation, seed } = e.data;
  try {
    const s = generation === 'gen1' ? gen1(seed) : storex(seed);
    s.trace = true;
    const r = runDay(s);
    (self as unknown as Worker).postMessage({ id, agents: r.trace?.agents ?? [] });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
