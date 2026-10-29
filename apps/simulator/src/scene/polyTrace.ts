import { VERTICAL_WEIGHT, type PolySegment } from '@storewright/sim-engine';

/** 折线轨迹片段的位置插值（后仓收货、叉车、夜班补货共用） */

export interface PolyPose {
  x: number;
  y: number;
  z: number;
  heading: number;
  moving: boolean;
  carry?: string;
  activity: string;
  /** 处在两个片段之间的空档（例如叉车举升）：上一个片段与空档进度 0–1 */
  gapAfter?: PolySegment;
  gapK: number;
  /** 当前片段与片段内进度 0–1（处在空档时为上一个片段、进度 1） */
  seg?: PolySegment;
  k: number;
}

const cum = new WeakMap<PolySegment, number[]>();

function lengths(s: PolySegment): number[] {
  let c = cum.get(s);
  if (!c) {
    c = [0];
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1] as PolySegment['pts'][number];
      const b = s.pts[i] as PolySegment['pts'][number];
      // 竖直方向（乘电梯、货梯）按仿真里同样的权重折算长度，楼层之间的移动和平面移动的速度一致
      c.push((c[i - 1] as number) + Math.hypot(b.x - a.x, b.z - a.z) + Math.abs(b.y - a.y) * VERTICAL_WEIGHT);
    }
    cum.set(s, c);
  }
  return c;
}

/** 停着时的朝向：沿用本轨迹最近一段移动的方向（不依赖上一次调用留下的值） */
function restHeading(segs: readonly PolySegment[], idx: number): number {
  for (let i = idx; i >= Math.max(0, idx - 8); i--) {
    const pts = (segs[i] as PolySegment).pts;
    for (let j = pts.length - 1; j > 0; j--) {
      const a = pts[j - 1] as PolySegment['pts'][number];
      const b = pts[j] as PolySegment['pts'][number];
      if (Math.abs(b.x - a.x) + Math.abs(b.z - a.z) > 1e-6) return Math.atan2(b.x - a.x, b.z - a.z);
    }
  }
  return 0;
}

export function makePolyPose(): PolyPose {
  return { x: 0, y: 0, z: 0, heading: 0, moving: false, activity: '', gapK: 0, k: 0 };
}

/**
 * 片段内的行驶距离比例：ease 秒内匀加速起步、最后 ease 秒匀减速停下，中间匀速（总时长不变）；ease 为 0 时匀速。
 * 叉车、搬运车按这个起步和刹车，不会一下子从静止变到全速。
 */
function travelFraction(k: number, dur: number, ease: number): number {
  if (ease <= 0 || dur <= 0) return k;
  const r = Math.min(ease, dur / 3) / dur;
  // 梯形速度：峰值 vmax 满足 vmax·(1 − r) = 1
  const vmax = 1 / (1 - r);
  if (k < r) return (0.5 * vmax * k * k) / r;
  if (k > 1 - r) {
    const u = 1 - k;
    return 1 - (0.5 * vmax * u * u) / r;
  }
  return 0.5 * vmax * r + vmax * (k - r);
}

function lerpAngle(a: number, b: number, f: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * f;
}

/** 在时刻 t 的位置；t 早于第一个片段或晚于最后一个片段时返回 false。opts.ease：起步 / 刹车用时（秒）；opts.corner：拐角处车头转向的过渡距离（米） */
export function polyPose(segs: readonly PolySegment[], t: number, out: PolyPose, opts: { ease?: number; corner?: number } = {}): boolean {
  if (!segs.length) return false;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((segs[mid] as PolySegment).t0 <= t) lo = mid;
    else hi = mid - 1;
  }
  const s = segs[lo] as PolySegment;
  if (t < s.t0) return false;
  out.gapAfter = undefined;
  out.gapK = 0;
  out.seg = s;
  out.k = Math.min(1, (t - s.t0) / Math.max(1e-6, s.t1 - s.t0));
  out.activity = s.activity;
  out.carry = s.carry;
  const c = lengths(s);
  const total = c[c.length - 1] as number;
  if (t >= s.t1) {
    // 片段之后的空档：停在终点
    const nxt = segs[lo + 1];
    if (!nxt && t > s.t1 + 1) return false;
    const p = s.pts[s.pts.length - 1] as PolySegment['pts'][number];
    out.x = p.x;
    out.y = p.y;
    out.z = p.z;
    out.moving = false;
    out.heading = restHeading(segs, lo);
    out.gapAfter = s;
    out.gapK = nxt ? Math.min(1, (t - s.t1) / Math.max(1, nxt.t0 - s.t1)) : 1;
    out.carry = undefined;
    return true;
  }
  if (s.pts.length === 1 || total === 0) {
    const p = s.pts[0] as PolySegment['pts'][number];
    out.x = p.x;
    out.y = p.y;
    out.z = p.z;
    out.moving = false;
    out.heading = restHeading(segs, lo);
    return true;
  }
  const dur = s.t1 - s.t0;
  const d = travelFraction((t - s.t0) / Math.max(1e-6, dur), dur, opts.ease ?? 0) * total;
  let i = 1;
  while (i < c.length - 1 && (c[i] as number) < d) i++;
  const a = s.pts[i - 1] as PolySegment['pts'][number];
  const b = s.pts[i] as PolySegment['pts'][number];
  const seg = (c[i] as number) - (c[i - 1] as number);
  const k = seg > 0 ? (d - (c[i - 1] as number)) / seg : 1;
  out.x = a.x + (b.x - a.x) * k;
  out.y = a.y + (b.y - a.y) * k;
  out.z = a.z + (b.z - a.z) * k;
  // 倒车的那几段：车头朝行进方向的反方向（叉车从车厢里倒出来）
  const legHeading = (j: number): number | undefined => {
    const p0 = s.pts[j - 1];
    const p1 = s.pts[j];
    if (!p0 || !p1 || Math.abs(p1.x - p0.x) + Math.abs(p1.z - p0.z) < 1e-6) return undefined;
    return Math.atan2(p1.x - p0.x, p1.z - p0.z) + (j - 1 < (s.reverseLegs ?? 0) ? Math.PI : 0);
  };
  out.heading = legHeading(i) ?? restHeading(segs, lo);
  // 拐角：车头在拐点前后 corner 米内逐渐转过去（拐点处正好转一半），不是瞬间转向
  const r = opts.corner ?? 0;
  if (r > 0) {
    const toNext = (c[i] as number) - d;
    const fromPrev = d - (c[i - 1] as number);
    const hn = legHeading(i + 1);
    const hp = legHeading(i - 1);
    if (toNext < r && hn !== undefined) out.heading = lerpAngle(out.heading, hn, 0.5 * (1 - toNext / r));
    else if (fromPrev < r && hp !== undefined) out.heading = lerpAngle(out.heading, hp, 0.5 * (1 - fromPrev / r));
  }
  out.moving = true;
  return true;
}
