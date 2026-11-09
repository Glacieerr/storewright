/// <reference lib="webworker" />
import { runDay } from '../../src/ops/day';
import { scenarioOf, type Knobs } from './scenario';

/** 仿真在后台线程里跑：一天大约 0.3–2 秒（记录动画轨迹时慢一些），不卡页面 */
export interface DayRequest {
  id: number;
  knobs: Knobs;
  trace: boolean;
}

self.onmessage = (e: MessageEvent<DayRequest>) => {
  const { id, knobs, trace } = e.data;
  try {
    const t0 = performance.now();
    const result = runDay(scenarioOf(knobs, trace));
    (self as unknown as Worker).postMessage({ id, result, ms: performance.now() - t0 });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
