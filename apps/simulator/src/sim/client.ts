import type { CompareRequest, DayDigest, MultiDayRequest, PolicyDigest, SimRequest, SimResponse, Timeline } from './protocol';

type Pending = { resolve: (v: never) => void; reject: (e: Error) => void; progress?: (done: number, total: number) => void };

/**
 * 仿真在 Web Worker 中运行，不阻塞渲染。
 * 主仿真和策略对比各用一个 Worker：对比要跑三遍，不应拖慢用户操作触发的主仿真。
 */
export class SimClient {
  private main = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private side = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private compareSeq = 0;
  /** 多日模拟用负数序号，不干扰策略对比的“最新请求”判断 */
  private multiSeq = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    const onMessage = (e: MessageEvent<SimResponse>) => {
      const msg = e.data;
      const p = this.pending.get(msg.reqId);
      if (!p) return;
      if (msg.type === 'progress') {
        p.progress?.(msg.done, msg.total);
        return;
      }
      this.pending.delete(msg.reqId);
      if (msg.type === 'result') p.resolve(msg.timeline as never);
      else if (msg.type === 'compare') p.resolve(msg.results as never);
      else if (msg.type === 'multiDay') p.resolve(msg.days as never);
      else p.reject(new Error(msg.message));
    };
    this.main.onmessage = onMessage;
    this.side.onmessage = onMessage;
  }

  simulate(req: Omit<SimRequest, 'type' | 'reqId'>): Promise<Timeline> {
    const reqId = ++this.seq * 2;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve: resolve as (v: never) => void, reject });
      this.main.postMessage({ ...req, type: 'simulate', reqId } satisfies SimRequest);
    });
  }

  compare(base: CompareRequest['base']): Promise<PolicyDigest[]> {
    const reqId = ++this.compareSeq * 2 + 1;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve: resolve as (v: never) => void, reject });
      this.side.postMessage({ type: 'compare', reqId, base } satisfies CompareRequest);
    });
  }

  /** 连续模拟多天（在对比用的 Worker 中运行，逐天回报进度） */
  multiDay(base: MultiDayRequest['base'], days: number, progress?: (done: number, total: number) => void): Promise<DayDigest[]> {
    const reqId = -++this.multiSeq;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve: resolve as (v: never) => void, reject, progress });
      this.side.postMessage({ type: 'multiDay', reqId, base, days } satisfies MultiDayRequest);
    });
  }

  /** 最近一次主仿真请求的序号 */
  get latest(): number {
    return this.seq;
  }

  get latestCompare(): number {
    return this.compareSeq;
  }

  get latestMultiDay(): number {
    return this.multiSeq;
  }
}
