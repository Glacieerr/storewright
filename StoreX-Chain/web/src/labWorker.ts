/// <reference lib="webworker" />
import { trainForecasts } from '../../src/analysis/forecast';
import { runDrill, type Notice } from '../../src/analysis/drill';
import { setRegion } from '../../src/region/network';
import type { RegionSpec } from '../../src/region/regionGen';
import { applyFacilities, type Facilities } from '../../src/facility/config';
import type { Gen } from '../../src/sim/config';

/** 「对比与报告」页的预测和演练在后台线程里跑（训练预测模型约 1–2 秒，一次演练零点几秒），边跑边报进度 */
export type LabRequest =
  | { id: number; type: 'forecast'; region?: RegionSpec; facilities?: Facilities }
  | { id: number; type: 'drill'; region?: RegionSpec; facilities?: Facilities; notice: Notice; gen: Gen; seeds?: number[] };

self.onmessage = (e: MessageEvent<LabRequest>) => {
  const req = e.data;
  const post = (msg: Record<string, unknown>) => (self as unknown as Worker).postMessage({ id: req.id, ...msg });
  try {
    if (req.region) setRegion(req.region);
    const fac = req.facilities;
    const prepare = fac ? (s: Parameters<typeof applyFacilities>[0]) => applyFacilities(s, fac) : undefined;
    if (req.type === 'forecast') {
      const report = trainForecasts({ ...(prepare ? { prepare } : {}), onProgress: (done, total, text) => post({ progress: { done, total, text } }) });
      post({ report });
    } else {
      const report = runDrill(req.notice, { gen: req.gen, ...(req.seeds ? { seeds: req.seeds } : {}), ...(prepare ? { prepare } : {}), onProgress: (done, total) => post({ progress: { done, total, text: `第 ${done} / ${total} 次运行` } }) });
      post({ report });
    }
  } catch (err) {
    post({ error: String(err) });
  }
};
