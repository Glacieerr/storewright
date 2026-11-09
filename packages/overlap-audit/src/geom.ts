/**
 * Footprint geometry: vehicle bodies as oriented rectangles on the ground plane (x, z), in two equivalent forms.
 * 车身在地面（x, z）上的矩形，两种写法：四个角（quad）和中心 + 朝向 + 半长半宽（OBB）。
 *
 * Quad convention: `[x0, z0, x1, z1, x2, z2, x3, z3]`, corners in order rear-A, front-A, front-B, rear-B
 * (so corner 0 → corner 1 points forward and corners 1–2 are the front edge). Either winding works for the overlap test.
 * 四个角的顺序：后 A、前 A、前 B、后 B（0 → 1 是车头方向，1–2 是车头那条边）；顺时针、逆时针都可以。
 */

/** Four corners, flattened: `[x0, z0, x1, z1, x2, z2, x3, z3]`. 四个角（展平）。 */
export type Quad = ArrayLike<number>;

/**
 * Oriented box: centre, unit forward direction (ux, uz), half length along it and half width across it.
 * 中心、单位朝向向量（车头方向）、沿朝向的半长、横向的半宽。
 */
export interface OBB {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  hl: number;
  hw: number;
}

/** Axis-aligned bounds. 轴对齐包围盒。 */
export interface AABB {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** A footprint in either form. 两种写法之一。 */
export type Shape = Quad | OBB;

export const isObb = (s: Shape): s is OBB => typeof (s as OBB).cx === 'number' && typeof (s as OBB).hl === 'number';

export interface OverlapOptions {
  /**
   * Whether rectangles that only touch (zero-width contact along a separating axis) count as overlapping. Default `false`.
   * 只是贴着（某条分离轴上投影正好相接）算不算重叠；默认不算。
   */
  touching?: boolean;
}

/**
 * Separating-axis test for two quads (the edge normals of both are the candidate axes; they need not be normalised).
 * 两个四边形的分离轴检验（两边各自的边法向都试一遍，不用归一化）。
 */
export function quadsOverlap(a: Quad, b: Quad, opts: OverlapOptions = {}): boolean {
  const touching = !!opts.touching;
  for (const P of [a, b])
    for (let i = 0; i < 4; i++) {
      const nx = -((P[((i + 1) % 4) * 2 + 1] as number) - (P[i * 2 + 1] as number));
      const nz = (P[((i + 1) % 4) * 2] as number) - (P[i * 2] as number);
      let amin = Infinity;
      let amax = -Infinity;
      let bmin = Infinity;
      let bmax = -Infinity;
      for (let k = 0; k < 4; k++) {
        const da = (a[k * 2] as number) * nx + (a[k * 2 + 1] as number) * nz;
        const db = (b[k * 2] as number) * nx + (b[k * 2 + 1] as number) * nz;
        if (da < amin) amin = da;
        if (da > amax) amax = da;
        if (db < bmin) bmin = db;
        if (db > bmax) bmax = db;
      }
      if (touching ? amax < bmin || bmax < amin : amax <= bmin || bmax <= amin) return false;
    }
  return true;
}

/**
 * Separating-axis test for two oriented boxes (four axes: each box's forward and lateral directions).
 * 两个 OBB 的分离轴检验（四条轴：各自的朝向和横向）。
 */
export function obbsOverlap(a: OBB, b: OBB, opts: OverlapOptions = {}): boolean {
  const touching = !!opts.touching;
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  const axes: [number, number][] = [
    [a.ux, a.uz],
    [-a.uz, a.ux],
    [b.ux, b.uz],
    [-b.uz, b.ux],
  ];
  for (const [nx, nz] of axes) {
    const ra = a.hl * Math.abs(a.ux * nx + a.uz * nz) + a.hw * Math.abs(-a.uz * nx + a.ux * nz);
    const rb = b.hl * Math.abs(b.ux * nx + b.uz * nz) + b.hw * Math.abs(-b.uz * nx + b.ux * nz);
    const d = Math.abs(dx * nx + dz * nz);
    if (touching ? d > ra + rb : d >= ra + rb) return false;
  }
  return true;
}

/** Corners of an oriented box in the quad convention (rear-A, front-A, front-B, rear-B). OBB → 四个角。 */
export function obbToQuad(o: OBB): number[] {
  const fx = o.ux * o.hl;
  const fz = o.uz * o.hl;
  const sx = -o.uz * o.hw;
  const sz = o.ux * o.hw;
  return [o.cx - fx + sx, o.cz - fz + sz, o.cx + fx + sx, o.cz + fz + sz, o.cx + fx - sx, o.cz + fz - sz, o.cx - fx - sx, o.cz - fz - sz];
}

/**
 * An oriented box from a heading angle. `heading` follows the `atan2(dx, dz)` convention (0 = facing +z, π/2 = facing +x);
 * pass `{ yaw: true }` for a three.js-style yaw (0 = facing +x, positive turns from +x towards −z).
 * 按朝向角做 OBB：heading 用 atan2(dx, dz)（0 朝 +z）；yaw: true 时按 three.js 的 yaw（0 朝 +x）。
 */
export function obbFromHeading(cx: number, cz: number, heading: number, halfLength: number, halfWidth: number, opts: { yaw?: boolean } = {}): OBB {
  const ux = opts.yaw ? Math.cos(heading) : Math.sin(heading);
  const uz = opts.yaw ? -Math.sin(heading) : Math.cos(heading);
  return { cx, cz, ux, uz, hl: halfLength, hw: halfWidth };
}

export function quadAabb(q: Quad): AABB {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < 4; k++) {
    const x = q[k * 2] as number;
    const z = q[k * 2 + 1] as number;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

export function obbAabb(o: OBB): AABB {
  const ex = Math.abs(o.ux) * o.hl + Math.abs(o.uz) * o.hw;
  const ez = Math.abs(o.uz) * o.hl + Math.abs(o.ux) * o.hw;
  return { minX: o.cx - ex, minZ: o.cz - ez, maxX: o.cx + ex, maxZ: o.cz + ez };
}

export const shapeAabb = (s: Shape): AABB => (isObb(s) ? obbAabb(s) : quadAabb(s));

/** Do two footprints (either form) overlap? Mixed pairs are tested as quads. 两个车身（任意写法）重叠吗。 */
export function shapesOverlap(a: Shape, b: Shape, opts: OverlapOptions = {}): boolean {
  if (isObb(a) && isObb(b)) return obbsOverlap(a, b, opts);
  return quadsOverlap(isObb(a) ? obbToQuad(a) : a, isObb(b) ? obbToQuad(b) : b, opts);
}

/** Centre of a quad (mean of the corners). 四个角的中心。 */
export function quadCenter(q: Quad): { x: number; z: number } {
  return { x: ((q[0] as number) + (q[2] as number) + (q[4] as number) + (q[6] as number)) / 4, z: ((q[1] as number) + (q[3] as number) + (q[5] as number) + (q[7] as number)) / 4 };
}

/** Heading of a quad, `atan2(dx, dz)` from corner 0 to corner 1. 四边形的朝向（角 0 → 角 1）。 */
export function quadHeading(q: Quad): number {
  return Math.atan2((q[2] as number) - (q[0] as number), (q[3] as number) - (q[1] as number));
}

/**
 * Is `trailer` hitched to `tractor`? True when the midpoint of the trailer's front edge (corners 1–2) lies within
 * `maxGap` metres of the tractor's centre and the two headings differ by less than `maxAngle`. A tractor and its own
 * trailer always overlap a little at the fifth wheel, so audits usually ignore such pairs.
 * 挂车是不是挂在这辆牵引车上：挂车车头那条边的中点离牵引车中心 maxGap 米以内、两者朝向差小于 maxAngle（默认 3.5 米、60°）。
 */
export function hitched(tractor: Quad, trailer: Quad, opts: { maxGap?: number; maxAngle?: number } = {}): boolean {
  const maxGap = opts.maxGap ?? 3.5;
  const maxAngle = opts.maxAngle ?? Math.PI / 3;
  const c = quadCenter(tractor);
  const fx = ((trailer[2] as number) + (trailer[4] as number)) / 2;
  const fz = ((trailer[3] as number) + (trailer[5] as number)) / 2;
  let d = Math.abs(quadHeading(tractor) - quadHeading(trailer)) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return Math.hypot(fx - c.x, fz - c.z) < maxGap && d < maxAngle;
}
