import * as THREE from 'three';

/**
 * 三维场景的几何工具：折线（长度、按距离取点、偏移、平滑、截取）、贝塞尔曲线，
 * 以及把条带、多边形、棱柱攒成一个带顶点颜色的几何体（同一种材质的东西合成一次绘制）。
 * 坐标：x 向东，z 向南，y 向上；「地图角度」按 x 向东、−z 向北计。
 */
export type V3 = THREE.Vector3;
export const v3 = (x: number, y: number, z: number): V3 => new THREE.Vector3(x, y, z);

export function cumulative(pts: readonly V3[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push((cum[i - 1] as number) + Math.hypot((pts[i] as V3).x - (pts[i - 1] as V3).x, (pts[i] as V3).z - (pts[i - 1] as V3).z));
  return cum;
}

/** 按水平距离 s 取点和方向（方向是单位向量，只在水平面上） */
export function sampleAt(pts: readonly V3[], cum: readonly number[], s: number): { p: V3; dx: number; dz: number; i: number } {
  const n = pts.length;
  if (n === 1) return { p: (pts[0] as V3).clone(), dx: 1, dz: 0, i: 0 };
  const total = cum[n - 1] as number;
  const ss = Math.max(0, Math.min(total, s));
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((cum[mid] as number) <= ss) lo = mid;
    else hi = mid;
  }
  const a = pts[lo] as V3;
  const b = pts[hi] as V3;
  const d = (cum[hi] as number) - (cum[lo] as number) || 1;
  const k = (ss - (cum[lo] as number)) / d;
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { p: new THREE.Vector3(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k), dx: (b.x - a.x) / len, dz: (b.z - a.z) / len, i: lo };
}

/** 截取 [s0, s1] 一段（含两端的插值点） */
export function slice(pts: readonly V3[], cum: readonly number[], s0: number, s1: number): V3[] {
  if (s1 <= s0) return [sampleAt(pts, cum, s0).p];
  const out = [sampleAt(pts, cum, s0).p];
  for (let i = 0; i < pts.length; i++) if ((cum[i] as number) > s0 + 1e-6 && (cum[i] as number) < s1 - 1e-6) out.push((pts[i] as V3).clone());
  out.push(sampleAt(pts, cum, s1).p);
  return out;
}

/** 等距重采样（转弯处更圆滑，标线和路灯可以按距离放） */
export function resample(pts: readonly V3[], step: number): V3[] {
  const cum = cumulative(pts);
  const total = cum[cum.length - 1] as number;
  const n = Math.max(1, Math.round(total / step));
  const out: V3[] = [];
  for (let k = 0; k <= n; k++) out.push(sampleAt(pts, cum, (total * k) / n).p);
  return out;
}

/** 折线拐角倒成圆弧（半径 r，太短的边按比例缩小），用于高速、匝道 */
export function fillet(pts: readonly V3[], r: number, seg = 8): V3[] {
  if (pts.length < 3) return pts.map((p) => p.clone());
  const out: V3[] = [(pts[0] as V3).clone()];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1] as V3;
    const b = pts[i] as V3;
    const c = pts[i + 1] as V3;
    const l1 = Math.hypot(b.x - a.x, b.z - a.z);
    const l2 = Math.hypot(c.x - b.x, c.z - b.z);
    // 重合的点：不倒角（否则方向是 NaN）
    if (l1 < 1e-6 || l2 < 1e-6) {
      if (l1 >= 1e-6) out.push(b.clone());
      continue;
    }
    const u1x = (b.x - a.x) / l1;
    const u1z = (b.z - a.z) / l1;
    const u2x = (c.x - b.x) / l2;
    const u2z = (c.z - b.z) / l2;
    const cos = Math.max(-1, Math.min(1, u1x * u2x + u1z * u2z));
    const ang = Math.acos(cos);
    if (ang < 0.01) {
      out.push(b.clone());
      continue;
    }
    const t = Math.min(r * Math.tan(ang / 2), l1 * 0.45, l2 * 0.45);
    const p0 = new THREE.Vector3(b.x - u1x * t, b.y, b.z - u1z * t);
    const p2 = new THREE.Vector3(b.x + u2x * t, b.y, b.z + u2z * t);
    for (let k = 0; k <= seg; k++) {
      const f = k / seg;
      // 二次贝塞尔近似圆弧
      out.push(new THREE.Vector3((1 - f) * (1 - f) * p0.x + 2 * (1 - f) * f * b.x + f * f * p2.x, b.y, (1 - f) * (1 - f) * p0.z + 2 * (1 - f) * f * b.z + f * f * p2.z));
    }
  }
  out.push((pts[pts.length - 1] as V3).clone());
  return out;
}

/** 闭合的 Catmull-Rom 样条（向心参数），环城高速用 */
export function closedSpline(ctrl: readonly V3[], perSeg: number): V3[] {
  const n = ctrl.length;
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n] as V3;
    const p1 = ctrl[i] as V3;
    const p2 = ctrl[(i + 1) % n] as V3;
    const p3 = ctrl[(i + 2) % n] as V3;
    const curve = new THREE.CatmullRomCurve3([p0, p1, p2, p3], false, 'centripetal');
    for (let k = 0; k < perSeg; k++) {
      // 只取中间那一段（1/3 到 2/3）
      out.push(curve.getPoint((1 + k / perSeg) / 3));
    }
  }
  out.push((out[0] as V3).clone());
  return out;
}

/** 三次贝塞尔：从 p0 沿方向 d0 出发，到 p3 时方向 d3；k 是控制点的长度比例 */
export function bezier(p0: V3, d0: { x: number; z: number }, p3: V3, d3: { x: number; z: number }, k = 0.4, n = 0): V3[] {
  const dist = Math.hypot(p3.x - p0.x, p3.z - p0.z);
  const L = Math.max(1, dist * k);
  const p1 = new THREE.Vector3(p0.x + d0.x * L, p0.y, p0.z + d0.z * L);
  const p2 = new THREE.Vector3(p3.x - d3.x * L, p3.y, p3.z - d3.z * L);
  const steps = n || Math.max(4, Math.ceil(dist / 4));
  const out: V3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = (1 - t) ** 3;
    const b = 3 * (1 - t) ** 2 * t;
    const c = 3 * (1 - t) * t * t;
    const d = t ** 3;
    out.push(new THREE.Vector3(a * p0.x + b * p1.x + c * p2.x + d * p3.x, a * p0.y + b * p1.y + c * p2.y + d * p3.y, a * p0.z + b * p1.z + c * p2.z + d * p3.z));
  }
  return out;
}

/** 折线向右（按行进方向）偏移 off 米；y 不变。拐角按平均法线处理（限制尖角） */
export function offset(pts: readonly V3[], off: number): V3[] {
  const n = pts.length;
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i] as V3;
    const a = pts[Math.max(0, i - 1)] as V3;
    const b = pts[Math.min(n - 1, i + 1)] as V3;
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    // 右侧 = (−dz, dx)
    let scale = 1;
    if (i > 0 && i < n - 1) {
      const ux = p.x - a.x;
      const uz = p.z - a.z;
      const ul = Math.hypot(ux, uz) || 1;
      const wx = b.x - p.x;
      const wz = b.z - p.z;
      const wl = Math.hypot(wx, wz) || 1;
      const cos = (ux / ul) * (wx / wl) + (uz / ul) * (wz / wl);
      scale = 1 / Math.max(0.5, Math.sqrt((1 + cos) / 2));
    }
    out.push(new THREE.Vector3(p.x - dz * off * scale, p.y, p.z + dx * off * scale));
  }
  return out;
}

export const reverse = (pts: readonly V3[]): V3[] => [...pts].reverse().map((p) => p.clone());
/** 地图角度（x 向东、−z 向北） */
export const mapAngle = (dx: number, dz: number): number => Math.atan2(-dz, dx);
export const dirOf = (ang: number): { x: number; z: number } => ({ x: Math.cos(ang), z: -Math.sin(ang) });

/** 点到线段的距离（水平） */
export function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz || 1)));
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}
export function polyDist(px: number, pz: number, pts: readonly V3[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, segDist(px, pz, (pts[i - 1] as V3).x, (pts[i - 1] as V3).z, (pts[i] as V3).x, (pts[i] as V3).z));
  return best;
}

/** 两条线段的交点（参数 t、u，都在 [0, 1] 内才算相交） */
export function segIntersect(a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }, d: { x: number; z: number }): { t: number; u: number } | undefined {
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const sx = d.x - c.x;
  const sz = d.z - c.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return undefined;
  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / den;
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : undefined;
}

export function pointInPoly(x: number, z: number, poly: readonly { x: number; z: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as { x: number; z: number };
    const b = poly[j] as { x: number; z: number };
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** 固定的伪随机数（场景每次都一样） */
export function rand(seed: number): () => number {
  let s = Math.abs(Math.floor(seed)) % 2147483646 || 1;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/**
 * 攒几何体：条带（沿折线、左右偏移、可抬高）、多边形、棱柱（路缘、中央隔离带、护栏）、方块。
 * 所有面都带顶点颜色，最后合成一个 BufferGeometry。
 */
export class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  private c = new THREE.Color();

  private vtx(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(this.c.r, this.c.g, this.c.b);
    return this.pos.length / 3 - 1;
  }

  color(c: THREE.ColorRepresentation): this {
    this.c.set(c);
    return this;
  }

  /** 四边形 a b c d（逆时针朝向法线） */
  quad(a: V3, b: V3, c: V3, d: V3, n?: V3): void {
    let nn = n;
    if (!nn) {
      const e1 = new THREE.Vector3().subVectors(b, a);
      const e2 = new THREE.Vector3().subVectors(d, a);
      nn = new THREE.Vector3().crossVectors(e2, e1).normalize();
      if (nn.lengthSq() < 0.5) nn.set(0, 1, 0);
    }
    const i0 = this.vtx(a.x, a.y, a.z, nn.x, nn.y, nn.z);
    const i1 = this.vtx(b.x, b.y, b.z, nn.x, nn.y, nn.z);
    const i2 = this.vtx(c.x, c.y, c.z, nn.x, nn.y, nn.z);
    const i3 = this.vtx(d.x, d.y, d.z, nn.x, nn.y, nn.z);
    this.idx.push(i0, i2, i1, i0, i3, i2);
  }

  /**
   * 沿折线铺条带：左边缘在行进方向左侧 offL 米、右边缘在右侧 offR 米（右为正），
   * 高度 = 折线点的 y + lift；朝上。
   */
  strip(pts: readonly V3[], offL: number, offR: number, lift: number): void {
    if (pts.length < 2) return;
    const L = offset(pts, offL);
    const R = offset(pts, offR);
    const base = this.pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const l = L[i] as V3;
      const r = R[i] as V3;
      this.vtx(l.x, l.y + lift, l.z, 0, 1, 0);
      this.vtx(r.x, r.y + lift, r.z, 0, 1, 0);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = base + i * 2;
      // 左 a、右 a+1、下一组左 a+2、右 a+3：保证从上方看是逆时针
      this.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  /** 竖直的边（路缘、护栏的侧面）：沿折线、偏移 off，从 y0 到 y1，法线朝 side（+1 右、−1 左） */
  wall(pts: readonly V3[], off: number, y0: number, y1: number, side: 1 | -1): void {
    if (pts.length < 2) return;
    const W = offset(pts, off);
    const base = this.pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const w = W[i] as V3;
      const a = pts[Math.max(0, i - 1)] as V3;
      const b = pts[Math.min(pts.length - 1, i + 1)] as V3;
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = (-(b.z - a.z) / len) * side;
      const nz = ((b.x - a.x) / len) * side;
      this.vtx(w.x, w.y + y0, w.z, nx, 0, nz);
      this.vtx(w.x, w.y + y1, w.z, nx, 0, nz);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = base + i * 2;
      if (side > 0) this.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      else this.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  /** 棱柱条：顶面 + 两侧（路缘石、隔离带、护栏） */
  prism(pts: readonly V3[], offL: number, offR: number, y0: number, y1: number): void {
    this.strip(pts, offL, offR, y1);
    this.wall(pts, offL, y0, y1, -1);
    this.wall(pts, offR, y0, y1, 1);
  }

  /** 水平多边形（逆时针或顺时针都行），高度 y */
  polygon(poly: readonly { x: number; z: number }[], y: number): void {
    if (poly.length < 3) return;
    const contour = poly.map((p) => new THREE.Vector2(p.x, -p.z));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const base = this.pos.length / 3;
    for (const p of poly) this.vtx(p.x, y, p.z, 0, 1, 0);
    // 每个三角形按实际的顶点顺序定朝向：法线朝上（不管轮廓是顺时针还是逆时针）
    for (const t of tris) {
      const a = poly[t[0] as number] as { x: number; z: number };
      const b = poly[t[1] as number] as { x: number; z: number };
      const c = poly[t[2] as number] as { x: number; z: number };
      const up = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z) > 0;
      if (up) this.idx.push(base + (t[0] as number), base + (t[1] as number), base + (t[2] as number));
      else this.idx.push(base + (t[0] as number), base + (t[2] as number), base + (t[1] as number));
    }
  }

  /** 方块（中心 x, z，底面 y），可绕 y 轴转 rot */
  box(x: number, y: number, z: number, w: number, h: number, d: number, rot = 0): void {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const P = (lx: number, ly: number, lz: number) => new THREE.Vector3(x + lx * c + lz * s, y + ly, z - lx * s + lz * c);
    const hw = w / 2;
    const hd = d / 2;
    const v = [P(-hw, 0, -hd), P(hw, 0, -hd), P(hw, 0, hd), P(-hw, 0, hd), P(-hw, h, -hd), P(hw, h, -hd), P(hw, h, hd), P(-hw, h, hd)];
    const q = (a: number, b: number, cc: number, d2: number) => this.quad(v[a] as V3, v[b] as V3, v[cc] as V3, v[d2] as V3);
    q(4, 5, 6, 7); // 顶
    q(3, 2, 1, 0); // 底
    q(0, 1, 5, 4);
    q(1, 2, 6, 5);
    q(2, 3, 7, 6);
    q(3, 0, 4, 7);
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * 线段的网格索引：判断一个点离哪条路（折线 + 半宽）近，不用每次扫全部的路。
 * margin 是查询时最大的额外距离（建索引时按它扩大每条线段占的格子）。
 */
export class SegGrid {
  private cells = new Map<number, number[]>();
  private segs: number[] = [];
  constructor(
    private readonly size = 40,
    private readonly margin = 12,
  ) {}

  private key(i: number, j: number): number {
    return (i + 5000) * 10007 + (j + 5000);
  }

  add(pts: readonly { x: number; z: number }[], r: number): void {
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1] as { x: number; z: number };
      const b = pts[k] as { x: number; z: number };
      const id = this.segs.length / 5;
      this.segs.push(a.x, a.z, b.x, b.z, r);
      const e = r + this.margin;
      const x0 = Math.floor((Math.min(a.x, b.x) - e) / this.size);
      const x1 = Math.floor((Math.max(a.x, b.x) + e) / this.size);
      const z0 = Math.floor((Math.min(a.z, b.z) - e) / this.size);
      const z1 = Math.floor((Math.max(a.z, b.z) + e) / this.size);
      for (let i = x0; i <= x1; i++)
        for (let j = z0; j <= z1; j++) {
          const kk = this.key(i, j);
          let list = this.cells.get(kk);
          if (!list) this.cells.set(kk, (list = []));
          list.push(id);
        }
    }
  }

  /** 点离某条线段不到「半宽 + pad」（pad 不超过 margin） */
  near(x: number, z: number, pad = 0): boolean {
    const list = this.cells.get(this.key(Math.floor(x / this.size), Math.floor(z / this.size)));
    if (!list) return false;
    const s = this.segs;
    for (const id of list) {
      const o = id * 5;
      if (segDist(x, z, s[o] as number, s[o + 1] as number, s[o + 2] as number, s[o + 3] as number) < (s[o + 4] as number) + pad) return true;
    }
    return false;
  }
}
