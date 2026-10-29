/**
 * 设备遥测（决策记录 0016 第 4.1 节）：每个传感器的最新读数、最近 60 分钟的原始读数（回放时精确到读数），
 * 加上按分钟汇总的时间序列（默认保留 24 小时）。
 * 遥测频率高、也不需要永久保存，所以不进作业事件流；只有越线告警作为作业事件记下来。
 * 正式部署时换成时序数据库，接口不变。
 */

export interface Reading {
  sensorId: string;
  /** 读数时间（毫秒） */
  at: number;
  value: number;
}

/** 一分钟的汇总 */
export interface Bucket {
  /** 这一分钟的开始时间 */
  t: number;
  min: number;
  max: number;
  avg: number;
  last: number;
  n: number;
}

const MIN = 60_000;

export class TelemetryStore {
  private readonly series = new Map<string, Bucket[]>();
  private readonly raw = new Map<string, Reading[]>();
  private readonly last = new Map<string, Reading>();

  constructor(
    private readonly keepMin = 24 * 60,
    private readonly rawMin = 60,
  ) {}

  /** 记下一条读数；不是有限数字、或比保留期更早的读数不收。晚到的读数（设备补传、网络排队）放进它所在的那一分钟 */
  ingest(r: Reading): boolean {
    if (!r || typeof r.sensorId !== 'string' || !Number.isFinite(r.value) || !Number.isFinite(r.at)) return false;
    const t = Math.floor(r.at / MIN) * MIN;
    let list = this.series.get(r.sensorId);
    if (!list) {
      list = [];
      this.series.set(r.sensorId, list);
    }
    const newest = list[list.length - 1];
    if (newest && t <= newest.t - this.keepMin * MIN) return false;
    const prev = this.last.get(r.sensorId);
    const isLatest = !prev || r.at >= prev.at;
    let i = list.length - 1;
    while (i >= 0 && (list[i] as Bucket).t > t) i--;
    const b = i >= 0 ? (list[i] as Bucket) : undefined;
    if (b && b.t === t) {
      b.min = Math.min(b.min, r.value);
      b.max = Math.max(b.max, r.value);
      b.avg = (b.avg * b.n + r.value) / (b.n + 1);
      b.n += 1;
      if (isLatest) b.last = r.value;
    } else {
      list.splice(i + 1, 0, { t, min: r.value, max: r.value, avg: r.value, last: r.value, n: 1 });
      if (list.length > this.keepMin) list.splice(0, list.length - this.keepMin);
    }
    const reading = { sensorId: r.sensorId, at: r.at, value: r.value };
    if (isLatest) this.last.set(r.sensorId, reading);
    let raw = this.raw.get(r.sensorId);
    if (!raw) {
      raw = [];
      this.raw.set(r.sensorId, raw);
    }
    let k = raw.length;
    while (k > 0 && (raw[k - 1] as Reading).at > r.at) k--;
    raw.splice(k, 0, reading);
    const cutoff = (raw[raw.length - 1] as Reading).at - this.rawMin * MIN;
    if ((raw[0] as Reading).at < cutoff) {
      let n = 0;
      while (n < raw.length && (raw[n] as Reading).at < cutoff) n++;
      raw.splice(0, n);
    }
    return true;
  }

  latest(sensorId: string): Reading | undefined {
    return this.last.get(sensorId);
  }

  latestAll(): Reading[] {
    return [...this.last.values()];
  }

  /** [from, to] 之间的分钟汇总 */
  range(sensorId: string, from: number, to: number): Bucket[] {
    return (this.series.get(sensorId) ?? []).filter((b) => b.t + MIN > from && b.t <= to);
  }

  /** t 时刻的读数：最近 60 分钟内按原始读数，更早的按那一分钟（或之前最近一分钟）的最后一个值；更早没有数据时为 undefined */
  valueAt(sensorId: string, t: number): number | undefined {
    const raw = this.raw.get(sensorId);
    if (raw?.length && (raw[0] as Reading).at <= t) {
      let a = 0;
      let z = raw.length - 1;
      while (a < z) {
        const mid = (a + z + 1) >> 1;
        if ((raw[mid] as Reading).at <= t) a = mid;
        else z = mid - 1;
      }
      return (raw[a] as Reading).value;
    }
    const list = this.series.get(sensorId);
    if (!list?.length) return undefined;
    let lo = 0;
    let hi = list.length - 1;
    if ((list[0] as Bucket).t > t) return undefined;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((list[mid] as Bucket).t <= t) lo = mid;
      else hi = mid - 1;
    }
    return (list[lo] as Bucket).last;
  }

  /**
   * 最近一段连续满足条件的读数从什么时候开始（例如温度从什么时候开始一直高于告警线）；最新读数不满足时为 undefined。
   * 先看原始读数（精确到每个读数）；一直满足到原始读数的开头时，再往前看分钟汇总（按每分钟的最后一个值）。
   * 中间缺了数据（设备离线超过 2 分钟）就不再往前找。
   */
  runStart(sensorId: string, pred: (v: number) => boolean): number | undefined {
    const raw = this.raw.get(sensorId) ?? [];
    let start: number | undefined;
    for (let i = raw.length - 1; i >= 0; i--) {
      const r = raw[i] as Reading;
      const next = raw[i + 1];
      if (!pred(r.value) || (next && next.at - r.at > 2 * MIN)) return start;
      start = r.at;
    }
    const list = this.series.get(sensorId) ?? [];
    let edge = start;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i] as Bucket;
      if (edge !== undefined && b.t + MIN > edge) continue;
      if (!pred(b.last) || (edge !== undefined && edge - (b.t + MIN) > 2 * MIN)) break;
      start = b.t;
      edge = b.t;
    }
    return start;
  }

  /** 最早的数据时间 */
  firstAt(): number | undefined {
    let first: number | undefined;
    for (const list of this.series.values()) {
      const b = list[0];
      if (b && (first === undefined || b.t < first)) first = b.t;
    }
    return first;
  }

  clear(): void {
    this.series.clear();
    this.raw.clear();
    this.last.clear();
  }
}
