import type { AgentKind, Segment } from '../../src/ops/trace';

/**
 * 按时间回放轨迹：某个人 / 机器人 / 车辆在时刻 t 在哪里、朝哪个方向、在做什么。
 * 二维俯视图、三维门店和三维区域场景共用这一份逻辑。
 */
export interface Pose {
  x: number;
  y: number;
  /** 朝向（弧度，atan2(dy, dx)，坐标系同布局：x 向右、y 向下） */
  dir: number;
  act?: string;
  moving: boolean;
  /** 是否在一段轨迹里（在干活或在路上） */
  busy: boolean;
}

/** 一直在场、不排班的（机器人、设备） vs 只在一段时间出现的（顾客、车辆） */
const TRANSIENT = new Set<AgentKind>(['shopper', 'truck', 'car', 'van']);

/** 回放需要的最少字段：门店里的人和机器人、区域里的车、船、飞机都满足 */
export interface Traceable {
  kind: string;
  segs: readonly Segment[];
  on?: readonly number[];
  home?: readonly number[];
}

export function onDuty(on: readonly number[], t: number): boolean {
  for (let i = 0; i < on.length; i += 2) {
    const a = on[i] as number;
    const b = on[i + 1] as number;
    if (t >= a && (Number.isNaN(b) || t < b)) return true;
  }
  return false;
}

/** 游标：播放时顺着往后走，拖动时间轴时二分查找；记住每个人最后的朝向 */
export class TraceCursor {
  private idx: Int32Array;
  private dir: Float32Array;

  /** transient：哪些类别只在自己的轨迹时段里出现（默认是顾客和车辆；区域场景里所有车船飞机都是） */
  constructor(
    private agents: readonly Traceable[],
    private transient: (kind: string) => boolean = (k) => TRANSIENT.has(k as AgentKind),
  ) {
    this.idx = new Int32Array(agents.length);
    this.dir = new Float32Array(agents.length);
  }

  pose(i: number, t: number): Pose | undefined {
    const a = this.agents[i] as Traceable;
    const segs = a.segs;
    if (a.on && !onDuty(a.on, t)) return undefined;
    if (!segs.length) {
      if (!a.home || this.transient(a.kind)) return undefined;
      return { x: a.home[0] as number, y: a.home[1] as number, dir: this.dir[i] as number, act: a.kind === 'porter' ? '站台拣货' : '待命', moving: false, busy: false };
    }
    if (this.transient(a.kind) && (t < (segs[0] as Segment).t0 || t > (segs[segs.length - 1] as Segment).t1)) return undefined;
    let k = this.idx[i] as number;
    if (k >= segs.length || (segs[k] as Segment).t0 > t) k = search(segs, t);
    else while (k + 1 < segs.length && (segs[k + 1] as Segment).t0 <= t) k++;
    this.idx[i] = k;
    const seg = segs[k] as Segment;
    if (seg.t0 > t) {
      const hx = (a.home?.[0] ?? seg.pts[0]) as number;
      const hy = (a.home?.[1] ?? seg.pts[1]) as number;
      return { x: hx, y: hy, dir: this.dir[i] as number, moving: false, busy: false };
    }
    if (t <= seg.t1) {
      const f = (t - seg.t0) / Math.max(1e-6, seg.t1 - seg.t0);
      const [x, y, dx, dy] = along(seg, f);
      if (dx !== 0 || dy !== 0) this.dir[i] = Math.atan2(dy, dx);
      return { x, y, dir: this.dir[i] as number, ...(seg.act ? { act: seg.act } : {}), moving: seg.pts.length > 2, busy: true };
    }
    // 两段之间：停在上一段的终点（顾客和车辆在最后一段之后已经不在场）
    const n = seg.pts.length;
    return { x: seg.pts[n - 2] as number, y: seg.pts[n - 1] as number, dir: this.dir[i] as number, moving: false, busy: false };
  }
}

function search(segs: readonly Segment[], t: number): number {
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((segs[mid] as Segment).t0 <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 沿折线按比例取点（匀速），同时返回所在那一段的方向 */
export function along(seg: Segment, f: number): [number, number, number, number] {
  const p = seg.pts;
  if (p.length <= 2) return [p[0] as number, p[1] as number, 0, 0];
  let total = 0;
  for (let i = 2; i < p.length; i += 2) total += Math.hypot((p[i] as number) - (p[i - 2] as number), (p[i + 1] as number) - (p[i - 1] as number));
  let want = Math.max(0, Math.min(1, f)) * total;
  for (let i = 2; i < p.length; i += 2) {
    const x0 = p[i - 2] as number;
    const y0 = p[i - 1] as number;
    const x1 = p[i] as number;
    const y1 = p[i + 1] as number;
    const d = Math.hypot(x1 - x0, y1 - y0);
    if (want <= d || i === p.length - 2) {
      const k = d > 0 ? Math.min(1, want / d) : 0;
      return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, x1 - x0, y1 - y0];
    }
    want -= d;
  }
  return [p[p.length - 2] as number, p[p.length - 1] as number, 0, 0];
}
