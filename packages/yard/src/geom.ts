import type { Pt } from './index';

/**
 * 场地几何的小工具：角度差、按距离等分的折线、真正的圆弧倒角、四分之一圆和半圆掉头、三点外接圆半径、有朝向的矩形相交。
 * 朝向一律是 atan2(dx, dz)（0 = 朝 +z），和第一部分 Storewright 的卸货场一样。
 */

/** b − a，归到 (−π, π] */
export function angDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

export const dirOf = (h: number): Pt => ({ x: Math.sin(h), z: Math.cos(h) });
export const headingOf = (dx: number, dz: number): number => Math.atan2(dx, dz);

/**
 * 按距离等分的折线（每 0.5 米一个点）：按距离取位置和朝向（朝向在相邻两段的中点之间插值，没有跳变）。
 * 点、累计距离、每一小段的朝向存在 Float64Array 里（一个点 32 字节；场地的车道、驶离路线每 0.25 米一个点，长墙上几十条路线）；
 * pts、cum 第一次读的时候才生成普通数组（以后读同一份），值和逐点算的一样。
 * Polyline resampled every 0.5 m; position and smooth heading by distance.
 */
export class Polyline {
  readonly length: number;
  /** 点数、坐标、累计距离（至少一个 0）、每一小段的朝向 */
  private readonly n: number;
  private readonly X: Float64Array;
  private readonly Z: Float64Array;
  private readonly C: Float64Array;
  private readonly H: Float64Array;
  private P?: Pt[];
  private Cm?: number[];

  constructor(raw: readonly Pt[], step = 0.5) {
    // 先数点数（和下面逐点生成的判断一样），再填
    let n = raw.length ? 1 : 0;
    for (let i = 1; i < raw.length; i++) {
      const p = raw[i] as Pt;
      const a = raw[i - 1] as Pt;
      const len = Math.hypot(p.x - a.x, p.z - a.z);
      if (len < 1e-6) continue;
      n += Math.max(1, Math.ceil(len / step));
    }
    const pad = n === 1;
    if (pad) n = 2;
    const X = new Float64Array(n);
    const Z = new Float64Array(n);
    let j = 0;
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i] as Pt;
      if (i === 0) {
        X[j] = p.x;
        Z[j] = p.z;
        j++;
        continue;
      }
      const a = raw[i - 1] as Pt;
      const len = Math.hypot(p.x - a.x, p.z - a.z);
      if (len < 1e-6) continue;
      const m = Math.max(1, Math.ceil(len / step));
      for (let k = 1; k <= m; k++) {
        X[j] = a.x + ((p.x - a.x) * k) / m;
        Z[j] = a.z + ((p.z - a.z) * k) / m;
        j++;
      }
    }
    if (pad) {
      X[1] = X[0] as number;
      Z[1] = Z[0] as number;
    }
    const C = new Float64Array(Math.max(1, n));
    const H = new Float64Array(Math.max(0, n - 1));
    for (let i = 1; i < n; i++) {
      const dx = (X[i] as number) - (X[i - 1] as number);
      const dz = (Z[i] as number) - (Z[i - 1] as number);
      const l = Math.hypot(dx, dz);
      C[i] = (C[i - 1] as number) + l;
      H[i - 1] = l > 1e-9 ? Math.atan2(dx, dz) : i >= 2 ? (H[i - 2] as number) : 0;
    }
    this.n = n;
    this.X = X;
    this.Z = Z;
    this.C = C;
    this.H = H;
    this.length = C[C.length - 1] as number;
  }

  /** 按距离等分以后的点（第一次读时生成，之后是同一份） */
  get pts(): Pt[] {
    if (!this.P) {
      const P: Pt[] = [];
      for (let i = 0; i < this.n; i++) P.push({ x: this.X[i] as number, z: this.Z[i] as number });
      this.P = P;
    }
    return this.P;
  }
  /** 每个点的累计距离 */
  get cum(): number[] {
    return (this.Cm ??= Array.from(this.C));
  }

  /** s 所在的小段下标（1 … n−1） */
  private seg(s: number): number {
    const C = this.C;
    let lo = 1;
    let hi = this.n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((C[mid] as number) < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** 距离 s 处的位置和朝向 */
  at(s: number, out: { x: number; z: number; heading: number }): void {
    if (this.n === 0) throw new TypeError("Cannot read properties of undefined (reading 'x')");
    const t = Math.min(this.length, Math.max(0, s));
    const i = this.seg(t);
    const X = this.X;
    const Z = this.Z;
    const C = this.C;
    const H = this.H;
    const ax = X[i - 1] as number;
    const az = Z[i - 1] as number;
    const l = (C[i] as number) - (C[i - 1] as number);
    const k = l > 1e-9 ? (t - (C[i - 1] as number)) / l : 1;
    out.x = ax + ((X[i] as number) - ax) * k;
    out.z = az + ((Z[i] as number) - az) * k;
    const hc = H[i - 1] as number;
    // 在前一段中点、本段中点、后一段中点之间插值
    if (k < 0.5) {
      const hp = i >= 2 ? (H[i - 2] as number) : hc;
      out.heading = hp + angDiff(hp, hc) * (0.5 + k);
    } else {
      const hn = i < H.length ? (H[i] as number) : hc;
      out.heading = hc + angDiff(hc, hn) * (k - 0.5);
    }
  }

  /** 距离 s 处的点 */
  point(s: number): Pt {
    const o = { x: 0, z: 0, heading: 0 };
    this.at(s, o);
    return { x: o.x, z: o.z };
  }

  /** 从距离 s 到终点的点列（第一个点是 s 处的插值） */
  from(s: number): Pt[] {
    const t = Math.min(this.length, Math.max(0, s));
    const i = this.seg(t);
    const out = [this.point(t)];
    for (let j = i; j < this.n; j++) out.push({ x: this.X[j] as number, z: this.Z[j] as number });
    return out;
  }

  /** 距离 s0 到 s1 的点列 */
  slice(s0: number, s1: number): Pt[] {
    const a = Math.min(this.length, Math.max(0, s0));
    const b = Math.min(this.length, Math.max(a, s1));
    const i0 = this.seg(a);
    const i1 = this.seg(b);
    const out = [this.point(a)];
    for (let j = i0; j < i1 && j < this.n; j++) {
      const c = this.C[j] as number;
      if (c > a + 1e-6 && c < b - 1e-6) out.push({ x: this.X[j] as number, z: this.Z[j] as number });
    }
    out.push(this.point(b));
    return out;
  }

  /** 离点 p 最近的位置（距离） */
  nearest(p: Pt): number {
    const X = this.X;
    const Z = this.Z;
    let best = 0;
    let bd = Infinity;
    for (let i = 1; i < this.n; i++) {
      const ax = X[i - 1] as number;
      const az = Z[i - 1] as number;
      const dx = (X[i] as number) - ax;
      const dz = (Z[i] as number) - az;
      const l2 = dx * dx + dz * dz;
      const k = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / l2)) : 0;
      const qx = ax + dx * k;
      const qz = az + dz * k;
      const d = (p.x - qx) ** 2 + (p.z - qz) ** 2;
      if (d < bd) {
        bd = d;
        best = (this.C[i - 1] as number) + Math.sqrt(l2) * k;
      }
    }
    return best;
  }
}

/**
 * 折线的拐角换成圆弧（与两边相切，半径 r；两边不够长时按能放下的最大半径，首尾两段可以用满、中间的段两头各用一半）。
 * 圆弧上每一点的转弯半径都是 r，大车转弯不会在弯顶突然变急（二次贝塞尔圆角的弯顶只有设定半径的 0.7 倍）。 * Replace polyline corners with tangent circular arcs of radius r (shrunk where segments are too short).
 */
export function fillet(pts: readonly Pt[], radius: number, spacing = 1): Pt[] {
  const src = pts.filter((p, i) => i === 0 || Math.hypot(p.x - (pts[i - 1] as Pt).x, p.z - (pts[i - 1] as Pt).z) > 1e-6);
  if (src.length < 3) return src.map((p) => ({ x: p.x, z: p.z }));
  const out: Pt[] = [{ x: (src[0] as Pt).x, z: (src[0] as Pt).z }];
  const n = src.length;
  for (let i = 1; i < n - 1; i++) {
    const a = src[i - 1] as Pt;
    const b = src[i] as Pt;
    const c = src[i + 1] as Pt;
    const l1 = Math.hypot(b.x - a.x, b.z - a.z);
    const l2 = Math.hypot(c.x - b.x, c.z - b.z);
    const u = { x: (b.x - a.x) / l1, z: (b.z - a.z) / l1 };
    const v = { x: (c.x - b.x) / l2, z: (c.z - b.z) / l2 };
    const theta = Math.acos(Math.min(1, Math.max(-1, u.x * v.x + u.z * v.z)));
    if (theta < 1e-3) {
      out.push({ x: b.x, z: b.z });
      continue;
    }
    const tmax = Math.min(i === 1 ? l1 : l1 / 2, i === n - 2 ? l2 : l2 / 2);
    const t = Math.min(radius * Math.tan(theta / 2), tmax);
    const r = t / Math.tan(theta / 2);
    const p0 = { x: b.x - u.x * t, z: b.z - u.z * t };
    // 圆心在转弯的一侧
    let nx = u.z;
    let nz = -u.x;
    if (nx * v.x + nz * v.z < 0) {
      nx = -nx;
      nz = -nz;
    }
    const cx = p0.x + nx * r;
    const cz = p0.z + nz * r;
    const a0 = Math.atan2(p0.z - cz, p0.x - cx);
    const p1 = { x: b.x + v.x * t, z: b.z + v.z * t };
    let da = Math.atan2(p1.z - cz, p1.x - cx) - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const steps = Math.max(4, Math.ceil((Math.abs(da) * r) / spacing));
    for (let k = 0; k <= steps; k++) out.push({ x: cx + r * Math.cos(a0 + (da * k) / steps), z: cz + r * Math.sin(a0 + (da * k) / steps) });
  }
  out.push({ x: (src[n - 1] as Pt).x, z: (src[n - 1] as Pt).z });
  return out;
}

/** 四分之一圆：从 p 出发、初始方向 d0（单位向量），转向 d1（与 d0 垂直），半径 r；不含起点 */
export function quarter(p: Pt, d0: Pt, d1: Pt, r: number, spacing = 1): Pt[] {
  const cx = p.x + d1.x * r;
  const cz = p.z + d1.z * r;
  const steps = Math.max(6, Math.ceil(((Math.PI / 2) * r) / spacing));
  const pts: Pt[] = [];
  for (let k = 1; k <= steps; k++) {
    const a = (k / steps) * (Math.PI / 2);
    pts.push({ x: cx - d1.x * r * Math.cos(a) + d0.x * r * Math.sin(a), z: cz - d1.z * r * Math.cos(a) + d0.z * r * Math.sin(a) });
  }
  return pts;
}

/**
 * 半圆掉头：从 (x, z0) 出发、开始方向沿 dirX（±1）的 x 方向，掉到 z1 后反向；半径 |z1 − z0| / 2。含起点和终点。
 */
export function uTurn(x: number, z0: number, z1: number, dirX: 1 | -1, spacing = 1): Pt[] {
  const r = Math.abs(z1 - z0) / 2;
  const zc = (z0 + z1) / 2;
  const s = Math.sign(z0 - zc) || 1;
  const steps = Math.max(12, Math.ceil((Math.PI * r) / spacing));
  const pts: Pt[] = [];
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * Math.PI;
    pts.push({ x: x + dirX * r * Math.sin(a), z: zc + s * r * Math.cos(a) });
  }
  return pts;
}

/** 三点外接圆半径（共线时是无穷大） */
export function circumradius(a: Pt, b: Pt, c: Pt): number {
  const ab = Math.hypot(b.x - a.x, b.z - a.z);
  const bc = Math.hypot(c.x - b.x, c.z - b.z);
  const ca = Math.hypot(a.x - c.x, a.z - c.z);
  const area2 = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
  return area2 > 1e-9 ? (ab * bc * ca) / (2 * area2) : Infinity;
}

/** 点列上最急的转弯半径：每隔 1.5 米取一点，用相隔 3 米的三个点的外接圆半径（不受折线细分的影响）；from / to 是距离范围 */
export function minRadius(pts: readonly Pt[], from = 0, to = Infinity): number {
  const line = new Polyline(pts, 0.25);
  const samples: Pt[] = [];
  for (let s = Math.max(0, from); s <= Math.min(line.length, to) + 1e-6; s += 1.5) samples.push(line.point(s));
  let r = Infinity;
  for (let i = 2; i < samples.length - 2; i++) r = Math.min(r, circumradius(samples[i - 2] as Pt, samples[i] as Pt, samples[i + 2] as Pt));
  return r;
}

/** 有朝向的矩形：中心、沿朝向的半长、半宽、朝向 */
export interface OBB {
  x: number;
  z: number;
  hl: number;
  hw: number;
  h: number;
}

function corners(r: OBB): Pt[] {
  const f = { x: Math.sin(r.h), z: Math.cos(r.h) };
  const s = { x: Math.cos(r.h), z: -Math.sin(r.h) };
  const out: Pt[] = [];
  for (const [u, v] of [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ] as const)
    out.push({ x: r.x + f.x * u * r.hl + s.x * v * r.hw, z: r.z + f.z * u * r.hl + s.z * v * r.hw });
  return out;
}
export const obbCorners = corners;

/** 角点的顺序（和 corners 一样） */
const CU = [1, 1, -1, -1] as const;
const CV = [1, -1, -1, 1] as const;

/**
 * 预先算好角点、两条分离轴和外接圆半径的矩形（倒车检查里一个矩形要和很多个比：只算一次）。
 * 角点、轴的算式和 corners / obbIntersects 一字不差，所以判断结果完全一样。
 */
export interface PreparedOBB {
  x: number;
  z: number;
  /** 外接圆半径 */
  r: number;
  cx: Float64Array;
  cz: Float64Array;
  /** 轴：朝向 h、h + π/2 的 (sin, cos) */
  ax: Float64Array;
}
export function newPrepared(): PreparedOBB {
  return { x: 0, z: 0, r: 0, cx: new Float64Array(4), cz: new Float64Array(4), ax: new Float64Array(4) };
}
export function prepareOBB(r: OBB, out: PreparedOBB = newPrepared()): PreparedOBB {
  const fx = Math.sin(r.h);
  const fz = Math.cos(r.h);
  const sx = Math.cos(r.h);
  const sz = -Math.sin(r.h);
  for (let i = 0; i < 4; i++) {
    const u = CU[i] as number;
    const v = CV[i] as number;
    out.cx[i] = r.x + fx * u * r.hl + sx * v * r.hw;
    out.cz[i] = r.z + fz * u * r.hl + sz * v * r.hw;
  }
  const t1 = r.h + Math.PI / 2;
  out.ax[0] = Math.sin(r.h);
  out.ax[1] = Math.cos(r.h);
  out.ax[2] = Math.sin(t1);
  out.ax[3] = Math.cos(t1);
  out.x = r.x;
  out.z = r.z;
  out.r = Math.sqrt(r.hl * r.hl + r.hw * r.hw);
  return out;
}
/** 在一条轴上分开了没有（和 obbIntersects 里的算法一样） */
function apart(a: PreparedOBB, b: PreparedOBB, x: number, z: number, margin: number): boolean {
  let amin = Infinity;
  let amax = -Infinity;
  let bmin = Infinity;
  let bmax = -Infinity;
  for (let i = 0; i < 4; i++) {
    const d = (a.cx[i] as number) * x + (a.cz[i] as number) * z;
    amin = Math.min(amin, d);
    amax = Math.max(amax, d);
  }
  for (let i = 0; i < 4; i++) {
    const d = (b.cx[i] as number) * x + (b.cz[i] as number) * z;
    bmin = Math.min(bmin, d);
    bmax = Math.max(bmax, d);
  }
  return amax + margin < bmin || bmax + margin < amin;
}
/**
 * 和 obbIntersects(a, b, margin) 结果一样。两个外接圆隔得远（中心距离 > √2 ×（两个半径 + 余量）再留 1 米²的余量）时
 * 一定在 a 的某条轴上分开，直接返回 false。
 */
export function preparedIntersects(a: PreparedOBB, b: PreparedOBB, margin = 0): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const R = a.r + b.r + margin;
  if (dx * dx + dz * dz > 2 * R * R + 1) return false;
  const A = a.ax;
  const B = b.ax;
  if (apart(a, b, A[0] as number, A[1] as number, margin)) return false;
  if (apart(a, b, A[2] as number, A[3] as number, margin)) return false;
  if (apart(a, b, B[0] as number, B[1] as number, margin)) return false;
  if (apart(a, b, B[2] as number, B[3] as number, margin)) return false;
  return true;
}

/**
 * 分离轴判断两个有朝向的矩形是否相交（margin：两边各留的余量，米）
 * Separating-axis test for two oriented rectangles, with an optional margin in metres.
 */
export function obbIntersects(a: OBB, b: OBB, margin = 0): boolean {
  const ca = corners(a);
  const cb = corners(b);
  for (const t of [a.h, a.h + Math.PI / 2, b.h, b.h + Math.PI / 2]) {
    const ax = { x: Math.sin(t), z: Math.cos(t) };
    let amin = Infinity;
    let amax = -Infinity;
    let bmin = Infinity;
    let bmax = -Infinity;
    for (const p of ca) {
      const d = p.x * ax.x + p.z * ax.z;
      amin = Math.min(amin, d);
      amax = Math.max(amax, d);
    }
    for (const p of cb) {
      const d = p.x * ax.x + p.z * ax.z;
      bmin = Math.min(bmin, d);
      bmax = Math.max(bmax, d);
    }
    if (amax + margin < bmin || bmax + margin < amin) return false;
  }
  return true;
}
