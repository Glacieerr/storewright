import { regionSpecFrom } from '../../src/region/regionGen';
import { defaultFacilities, isDefault, type Facilities } from '../../src/facility/config';
import type { LabRequest } from './labWorker';

/**
 * 预测和演练的后台线程（两个面板共用一个，按顺序排队）。区域和设施配置跟「孪生」页一样：
 * 网页地址里的 ?region=、管理台存在本机浏览器里的设施配置。
 */
type Req = LabRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id' | 'region' | 'facilities'> : never) : never;
export interface Progress {
  done: number;
  total: number;
  text: string;
}

let worker: Worker | undefined;
let seq = 0;
const pending = new Map<number, { ok: (v: unknown) => void; bad: (e: Error) => void; progress?: (p: Progress) => void }>();

function facilities(): Facilities | undefined {
  try {
    const saved = localStorage.getItem('storex-chain-facilities');
    if (!saved) return undefined;
    const s = JSON.parse(saved) as Partial<Facilities>;
    const d = defaultFacilities();
    const f: Facilities = { port: { ...d.port, ...s.port }, airport: { ...d.airport, ...s.airport }, dc: { ...d.dc, ...s.dc }, store: { ...d.store, ...s.store } };
    return isDefault(f) ? undefined : f;
  } catch {
    return undefined;
  }
}

export function labCall<T>(req: Req, progress?: (p: Progress) => void): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./labWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; progress?: Progress; error?: string; report?: unknown }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      if (e.data.progress) {
        p.progress?.(e.data.progress);
        return;
      }
      pending.delete(e.data.id);
      if (e.data.error) p.bad(new Error(e.data.error));
      else p.ok(e.data.report);
    };
  }
  const id = ++seq;
  const region = regionSpecFrom(new URLSearchParams(location.search).get('region'));
  const fac = facilities();
  return new Promise<T>((ok, bad) => {
    pending.set(id, { ok: ok as (v: unknown) => void, bad, ...(progress ? { progress } : {}) });
    (worker as Worker).postMessage({ ...req, id, region, ...(fac ? { facilities: fac } : {}) } as LabRequest);
  });
}
