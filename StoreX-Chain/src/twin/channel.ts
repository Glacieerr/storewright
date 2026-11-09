import { Rng } from '../../../StoreX/src/core/rng';
import type { Msg } from './types';

/**
 * 通信质量：现场的数据到孪生之前经过的通道。真实的车载终端会丢点、晚到（排队重发），过隧道、偏远路段会断线一阵。
 *
 * - 良好：原样送到（默认，和以前完全一样，也不用随机数）；
 * - 一般 / 较差：定位、温度、装车进度、电量可能丢；车载终端的事件、门磁、收银盘点不会丢（终端会重发），但可能晚到；
 *   每辆车每小时有一定的概率断线一阵（这段时间的定位全丢）。
 * 孪生这边的补偿：晚到的定位比已经收到的还旧就不用（只按最新的位置估计），晚到的事件按发生的时刻补记；
 * 断线时按计划和最后知道的延误推算位置。统计全记下来给「数据质量」面板。
 */
export type DataQuality = 'good' | 'fair' | 'poor';
export const QUALITY_LABEL: Record<DataQuality, string> = { good: '良好', fair: '一般（偶尔丢点、晚到）', poor: '较差（常断线、数据晚到）' };
const PARAMS: Record<Exclude<DataQuality, 'good'>, { drop: number; late: number; lat: [number, number]; blackout: number; blackMin: number }> = {
  fair: { drop: 0.03, late: 0.08, lat: [20, 120], blackout: 0.03, blackMin: 8 },
  poor: { drop: 0.1, late: 0.2, lat: [30, 300], blackout: 0.1, blackMin: 15 },
};
/** 会丢的数据（周期上报的）；其余的终端会重发，只会晚到 */
const LOSSY = new Set<Msg['kind']>(['gps', 'temp', 'load', 'soc']);

export interface QualityStats {
  level: DataQuality;
  sent: number;
  delivered: number;
  dropped: number;
  /** 断线丢掉的定位（算在 dropped 里） */
  blackout: number;
  late: number;
  /** 晚到的平均秒数 */
  lateSec: number;
  /** 晚到的定位比已经收到的旧、没用上的 */
  stale: number;
  /** 晚到、按发生时刻补记的事件 */
  eventsLate: number;
  /** 最长的定位断点（分钟）和是哪辆车 */
  maxGap: number;
  maxGapVid: number;
  /** 孪生按计划推算位置的次数（车 · 5 分钟：在路上、超过 3 分钟没收到定位） */
  reckoned: number;
}

export class Channel {
  readonly stats: QualityStats;
  private readonly r: Rng | undefined;
  private queue: { at: number; m: Msg }[] = [];
  private readonly black = new Map<number, number>();
  private readonly lastGps = new Map<number, number>();

  constructor(
    readonly level: DataQuality,
    seed: number,
  ) {
    this.stats = { level, sent: 0, delivered: 0, dropped: 0, blackout: 0, late: 0, lateSec: 0, stale: 0, eventsLate: 0, maxGap: 0, maxGapVid: -1, reckoned: 0 };
    // 单独的随机数：不影响现场其余的状况
    if (level !== 'good') this.r = new Rng(seed * 7907 + 3).fork('channel');
  }

  /** 现场发出一条：丢掉、马上送到，或者排队晚一点送到 */
  send(m: Msg, now: number): void {
    this.stats.sent++;
    const r = this.r;
    if (!r || this.level === 'good') {
      this.queue.push({ at: now, m });
      return;
    }
    const p = PARAMS[this.level];
    if (m.kind === 'gps') {
      const until = this.black.get(m.vid) ?? -Infinity;
      if (m.t < until) {
        this.stats.dropped++;
        this.stats.blackout++;
        return;
      }
      // 每辆车每小时 blackout 的概率开始断线（按分钟折算）
      if (r.next() < p.blackout / 60) {
        this.black.set(m.vid, m.t + p.blackMin * 60);
        this.stats.dropped++;
        this.stats.blackout++;
        return;
      }
    }
    if (LOSSY.has(m.kind) && r.next() < p.drop) {
      this.stats.dropped++;
      return;
    }
    if (r.next() < p.late) {
      const lat = p.lat[0] + r.next() * (p.lat[1] - p.lat[0]);
      this.queue.push({ at: now + lat, m });
      return;
    }
    this.queue.push({ at: now, m });
  }

  /** 到 now 为止送到孪生的（按到达的先后）；过时的定位不交给孪生 */
  deliver(now: number): Msg[] {
    if (!this.queue.length) return [];
    const ready = this.queue.filter((x) => x.at <= now).sort((a, b) => a.at - b.at);
    if (!ready.length) return [];
    this.queue = this.queue.filter((x) => x.at > now);
    const out: Msg[] = [];
    for (const { at, m } of ready) {
      const lat = at - m.t;
      if (lat > 1) {
        this.stats.late++;
        this.stats.lateSec += lat;
        if (m.kind === 'event' || m.kind === 'door') this.stats.eventsLate++;
      }
      if (m.kind === 'gps') {
        const last = this.lastGps.get(m.vid);
        if (last !== undefined && m.t <= last) {
          this.stats.stale++;
          continue;
        }
        if (last !== undefined && m.t - last > this.stats.maxGap * 60) {
          this.stats.maxGap = (m.t - last) / 60;
          this.stats.maxGapVid = m.vid;
        }
        this.lastGps.set(m.vid, m.t);
      }
      this.stats.delivered++;
      out.push(m);
    }
    return out;
  }

  /** 这辆车最后一次收到定位的时刻 */
  gpsAt(vid: number): number | undefined {
    return this.lastGps.get(vid);
  }

  /** 统计（晚到的平均秒数算好） */
  summary(): QualityStats {
    return { ...this.stats, lateSec: this.stats.late ? this.stats.lateSec / this.stats.late : 0 };
  }
}
