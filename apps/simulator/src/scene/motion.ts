import type { AssociateTrace, Role, TraceSegment } from '@storewright/sim-engine';
import type { StoreModel } from '@storewright/store-config';
import type { CarInfo, Timeline } from '../sim/protocol';
import { nodeWorld, type StoreGeometry, type Vec3 } from './layout';
import { carSpot } from './lot';

/** 沿最短路径插值的折线（带累计长度），按 (from, to) 缓存 */
interface Polyline {
  pts: Vec3[];
  cum: number[];
  total: number;
}

export interface Pose {
  visible: boolean;
  x: number;
  y: number;
  z: number;
  heading: number;
  moving: boolean;
  /** 拣货员推着车 */
  withCart: boolean;
  segment?: TraceSegment;
}

export class MotionIndex {
  private polyCache = new Map<string, Polyline>();
  private roleIndex = new Map<string, number>();

  constructor(
    private readonly model: StoreModel,
    private readonly geo: StoreGeometry,
    private readonly timeline: Timeline,
  ) {
    const counters: Record<string, number> = {};
    for (const a of timeline.associates) {
      counters[a.role] = (counters[a.role] ?? 0) + 1;
      this.roleIndex.set(a.id, counters[a.role] as number);
    }
  }

  private node(id: number): Vec3 {
    return nodeWorld(this.model, this.geo.floorY, id);
  }

  private polyline(from: number, to: number): Polyline {
    const key = `${from}>${to}`;
    let p = this.polyCache.get(key);
    if (!p) {
      const ids = this.model.path(from, to);
      const pts = (ids.length ? ids : [from, to]).map((n) => this.node(n));
      const cum = [0];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1] as Vec3;
        const b = pts[i] as Vec3;
        cum.push((cum[i - 1] as number) + Math.hypot(b.x - a.x, b.z - a.z, (b.y - a.y) * 0.3));
      }
      p = { pts, cum, total: cum[cum.length - 1] as number };
      this.polyCache.set(key, p);
    }
    return p;
  }

  private along(p: Polyline, f: number, out: Pose): void {
    if (p.pts.length === 1 || p.total === 0) {
      const a = p.pts[0] as Vec3;
      out.x = a.x;
      out.y = a.y;
      out.z = a.z;
      return;
    }
    const d = Math.min(1, Math.max(0, f)) * p.total;
    let i = 1;
    while (i < p.cum.length - 1 && (p.cum[i] as number) < d) i++;
    const a = p.pts[i - 1] as Vec3;
    const b = p.pts[i] as Vec3;
    const seg = (p.cum[i] as number) - (p.cum[i - 1] as number);
    const k = seg > 0 ? (d - (p.cum[i - 1] as number)) / seg : 0;
    out.x = a.x + (b.x - a.x) * k;
    out.y = a.y + (b.y - a.y) * k;
    out.z = a.z + (b.z - a.z) * k;
    if (Math.abs(b.x - a.x) + Math.abs(b.z - a.z) > 1e-6) out.heading = Math.atan2(b.x - a.x, b.z - a.z);
  }

  /** 二分查找 t 所在的片段 */
  static segmentAt(segs: readonly TraceSegment[], t: number): TraceSegment | undefined {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segs[mid] as TraceSegment;
      if (t < s.t0) hi = mid - 1;
      else if (t >= s.t1) lo = mid + 1;
      else return s;
    }
    return undefined;
  }

  onShift(a: AssociateTrace, t: number): boolean {
    return a.shifts.some(([on, off]) => t >= on && t < off);
  }

  /** 员工在时刻 t 的位置；home 指定空闲时的待命节点（默认按岗位） */
  associatePose(a: AssociateTrace, t: number, out: Pose, home?: number): Pose {
    out.visible = this.onShift(a, t);
    out.moving = false;
    out.withCart = false;
    out.segment = undefined;
    if (!out.visible) return out;
    const s = MotionIndex.segmentAt(a.segments, t);
    const idx = this.roleIndex.get(a.id) ?? 0;
    if (s) {
      out.segment = s;
      if (s.kind === 'MOVE') {
        out.moving = true;
        this.along(this.polyline(s.from, s.to), (t - s.t0) / (s.t1 - s.t0), out);
      } else {
        const n = this.node(s.from);
        const car = s.ref ? this.carBySession.get(s.ref) : undefined;
        if (car && (s.activity === '车边交付' || s.activity === '司机交接')) {
          // 从门口走到车尾（后备箱），交付后走回门口；步行时间取自作业时长的一部分
          const spot = carSpot(this.geo.lot, car.spot);
          const fx = Math.sin(spot.heading);
          const fz = Math.cos(spot.heading);
          const tx = spot.x - fx * 3.0 + 0.6;
          const tz = spot.z - fz * 3.0;
          const walk = Math.min((s.t1 - s.t0) * 0.3, Math.hypot(tx - n.x, tz - n.z) / 1.3);
          const e = t - s.t0;
          const rem = s.t1 - t;
          let k = 1;
          if (e < walk) k = e / walk;
          else if (rem < walk) k = rem / walk;
          out.x = n.x + (tx - n.x) * k;
          out.y = 0;
          out.z = n.z + (tz - n.z) * k;
          out.moving = k < 1;
          out.heading = e < walk ? Math.atan2(tx - n.x, tz - n.z) : rem < walk ? Math.atan2(n.x - tx, n.z - tz) : Math.atan2(fx, fz);
        } else {
          // 同一节点上的多人错开站位
          const ang = (idx * 2.399) % (Math.PI * 2);
          out.x = n.x + Math.cos(ang) * 0.35;
          out.y = n.y;
          out.z = n.z + Math.sin(ang) * 0.35;
        }
      }
      // 拣货员推拣货车；夜班补货推货车（任务号以 RS- 开头）
      out.withCart = !!s.ref && ((a.role === 'pick' && s.ref.startsWith('W')) || s.ref.startsWith('RS-'));
      return out;
    }
    // 空闲：在本岗位待命位置排成一行
    const h = this.node(home ?? this.timeline.homeNodes[a.role as Role]);
    out.x = h.x + 1.2 + (idx % 6) * 0.7;
    out.y = h.y;
    out.z = h.z - 1.5 - Math.floor(idx / 6) * 0.7;
    out.heading = Math.PI;
    return out;
  }

  private _carBySession?: Map<string, CarInfo>;
  get carBySession(): Map<string, CarInfo> {
    if (!this._carBySession) this._carBySession = new Map(this.timeline.cars.map((c) => [c.id, c]));
    return this._carBySession;
  }
}

/** 车辆状态：驶入 / 等待 / 等待过久 / 正在交付 / 驶离 */
export type CarState = 'hidden' | 'arriving' | 'waiting' | 'longWait' | 'serving' | 'leaving';

export function carState(car: CarInfo, t: number, longWaitSec: number, serving: boolean): CarState {
  if (t < car.arriveAt - 20 || t > car.doneAt + 20) return 'hidden';
  if (t < car.arriveAt) return 'arriving';
  if (t > car.doneAt) return 'leaving';
  if (serving) return 'serving';
  return t - car.arriveAt >= longWaitSec ? 'longWait' : 'waiting';
}

/** 暂存占用：按时间增量维护，时间倒退时从头重算 */
export class StagingState {
  readonly counts = new Map<string, number>();
  private idx = 0;
  private time = Number.NEGATIVE_INFINITY;

  constructor(private readonly changes: Timeline['staging']) {}

  update(t: number): void {
    if (t < this.time) {
      this.counts.clear();
      this.idx = 0;
    }
    this.time = t;
    while (this.idx < this.changes.length && (this.changes[this.idx] as Timeline['staging'][number]).t <= t) {
      const c = this.changes[this.idx++] as Timeline['staging'][number];
      this.counts.set(c.slotCode, Math.max(0, (this.counts.get(c.slotCode) ?? 0) + c.delta));
    }
  }
}
