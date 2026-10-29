import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * 载具建模工具：把车身、玻璃、饰条、灯等部件收集到两份几何体里——
 * 「车漆」（不带顶点色，按实例着色）和「细节」（带固定的顶点色）。
 * 主要的建模方式是放样（loft）：沿车长方向排一串截面，截面是车身右半边从底部中点绕到顶部中点的折线，
 * 左半边镜像；相邻截面之间的每个四边形按位置分类成车漆、玻璃、饰条等材质（窗户、门缝、轮拱都这样得到）。
 * 法线按网格解析计算，车身表面是平滑的。
 */

export type Mat = 'paint' | 'glass' | 'trim' | 'chrome' | 'light' | 'tail' | 'amber' | 'plate' | 'rubber' | 'accent' | 'white' | 'wood' | 'canvas' | 'deck' | 'cushion' | 'navy' | 'alu';

export const MAT_COLOR: Record<Exclude<Mat, 'paint'>, THREE.Color> = {
  glass: new THREE.Color('#2e4250'),
  trim: new THREE.Color('#2a2d31'),
  chrome: new THREE.Color('#c7ccd1'),
  light: new THREE.Color('#f4f1e6'),
  tail: new THREE.Color('#c8262b'),
  amber: new THREE.Color('#f0a020'),
  plate: new THREE.Color('#eef0ea'),
  rubber: new THREE.Color('#1d1f22'),
  accent: new THREE.Color('#8a5a3c'),
  white: new THREE.Color('#f2f3ef'),
  wood: new THREE.Color('#b9895a'),
  canvas: new THREE.Color('#f4f1e8'),
  deck: new THREE.Color('#cfd3cd'),
  cushion: new THREE.Color('#e4d8bf'),
  navy: new THREE.Color('#26354f'),
  alu: new THREE.Color('#b7bec5'),
};

const GLASS_TOP = new THREE.Color('#6f8fa3');
const _c = new THREE.Color();

export class MeshBuilder {
  private readonly paint = { pos: [] as number[], nrm: [] as number[] };
  private readonly detail = { pos: [] as number[], nrm: [] as number[], col: [] as number[] };
  /** 玻璃顶点色的渐变范围（上亮下暗，像映着天空） */
  glassY0 = 0.8;
  glassY1 = 1.6;
  /** 某些部件用自定义颜色（例如房车的彩条） */
  custom = new Map<string, THREE.Color>();

  private colorFor(mat: Exclude<Mat, 'paint'>, y: number, out: THREE.Color): THREE.Color {
    if (mat === 'glass') {
      const k = Math.min(1, Math.max(0, (y - this.glassY0) / Math.max(0.01, this.glassY1 - this.glassY0)));
      return out.copy(MAT_COLOR.glass).lerp(GLASS_TOP, k * 0.75);
    }
    return out.copy(MAT_COLOR[mat]);
  }

  tri(mat: Mat, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, na?: THREE.Vector3, nb?: THREE.Vector3, nc?: THREE.Vector3, color?: THREE.Color): void {
    let n0 = na;
    let n1 = nb;
    let n2 = nc;
    if (!n0 || !n1 || !n2) {
      const f = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      if (f.lengthSq() < 1e-14) return;
      f.normalize();
      n0 = n1 = n2 = f;
    }
    const tgt = mat === 'paint' ? this.paint : this.detail;
    for (const [p, n] of [
      [a, n0],
      [b, n1],
      [c, n2],
    ] as const) {
      tgt.pos.push(p.x, p.y, p.z);
      tgt.nrm.push(n.x, n.y, n.z);
      if (mat !== 'paint') {
        const cc = color ?? this.colorFor(mat, p.y, _c);
        this.detail.col.push(cc.r, cc.g, cc.b);
      }
    }
  }

  /** 把一个现成的几何体（已经放在车辆局部坐标里）并进来 */
  part(geo: THREE.BufferGeometry, mat: Mat, color?: THREE.Color): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const tgt = mat === 'paint' ? this.paint : this.detail;
    for (let i = 0; i < p.count; i++) {
      tgt.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      tgt.nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      if (mat !== 'paint') {
        const cc = color ?? this.colorFor(mat, p.getY(i), _c);
        this.detail.col.push(cc.r, cc.g, cc.b);
      }
    }
  }

  box(mat: Mat, w: number, h: number, d: number, x: number, y: number, z: number, opts: { r?: number; rx?: number; ry?: number; rz?: number; color?: THREE.Color } = {}): void {
    // 小部件的圆角只用一段（看起来是倒角），省三角形；很薄的部件不倒角
    const min = Math.min(w, h, d);
    const g = opts.r && opts.r > 0 && min > 0.035 ? new RoundedBoxGeometry(w, h, d, min < 0.25 ? 1 : 2, Math.min(opts.r, w / 2, h / 2, d / 2)) : new THREE.BoxGeometry(w, h, d);
    if (opts.rx) g.rotateX(opts.rx);
    if (opts.ry) g.rotateY(opts.ry);
    if (opts.rz) g.rotateZ(opts.rz);
    g.translate(x, y, z);
    this.part(g, mat, opts.color);
  }

  /** 圆柱：axis 为 'x' | 'y' | 'z' */
  cyl(mat: Mat, r0: number, r1: number, len: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'y', seg = 12, color?: THREE.Color): void {
    const g = new THREE.CylinderGeometry(r1, r0, len, seg);
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.part(g, mat, color);
  }

  /** 沿一串点的细管（扶手、绳索、排气管弯头） */
  tube(mat: Mat, pts: THREE.Vector3[], r: number, seg = 6, color?: THREE.Color): void {
    if (pts.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const g = new THREE.TubeGeometry(curve, Math.max(4, pts.length * 4), r, seg, false);
    this.part(g, mat, color);
  }

  build(): { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
    const paint = new THREE.BufferGeometry();
    paint.setAttribute('position', new THREE.Float32BufferAttribute(this.paint.pos, 3));
    paint.setAttribute('normal', new THREE.Float32BufferAttribute(this.paint.nrm, 3));
    paint.computeBoundingSphere();
    const detail = new THREE.BufferGeometry();
    detail.setAttribute('position', new THREE.Float32BufferAttribute(this.detail.pos, 3));
    detail.setAttribute('normal', new THREE.Float32BufferAttribute(this.detail.nrm, 3));
    detail.setAttribute('color', new THREE.Float32BufferAttribute(this.detail.col, 3));
    detail.computeBoundingSphere();
    return { paint, detail };
  }
}

/** 一个截面：z 位置与右半边的点（x ≥ 0），从底部中点（x = 0）绕到顶部中点（x = 0） */
export interface Section {
  z: number;
  pts: Array<[number, number]>;
}

/** 四边形的分类信息：所在的截面段（band = 右半边第几段）、z 范围与中心、法线 */
export interface QuadInfo {
  band: number;
  z0: number;
  z1: number;
  zc: number;
  xc: number;
  yc: number;
  ny: number;
  nz: number;
  right: boolean;
}

/**
 * 放样：相邻截面之间连成四边形，按 classify 分类材质（返回 null 的四边形不画，用来开出船的座舱口）；
 * 两端按 caps 封口（扇形）。flip 为 true 时法线朝内（船的座舱内壁）。
 * 所有截面的点数必须相同；sections 按 z 从小（车尾）到大（车头）排列。
 */
export function loft(b: MeshBuilder, sections: Section[], classify: (q: QuadInfo) => Mat | null, caps: { rear?: Mat; front?: Mat } = {}, flip = false): void {
  const n = sections[0]?.pts.length ?? 0;
  if (n < 3 || sections.length < 2) return;
  const m = 2 * n - 2;
  // 网格点：ring[k][j]
  const ring: THREE.Vector3[][] = sections.map((s) => {
    const r: THREE.Vector3[] = [];
    for (let j = 0; j < n; j++) r.push(new THREE.Vector3((s.pts[j] as [number, number])[0], (s.pts[j] as [number, number])[1], s.z));
    for (let j = n - 2; j >= 1; j--) r.push(new THREE.Vector3(-(s.pts[j] as [number, number])[0], (s.pts[j] as [number, number])[1], s.z));
    return r;
  });
  const K = ring.length;
  const centerY = (k: number) => {
    const r = ring[k] as THREE.Vector3[];
    let y = 0;
    for (const p of r) y += p.y;
    return y / r.length;
  };
  const cy = sections.map((_, k) => centerY(k));
  // 解析法线：沿截面方向和沿车长方向的切线叉乘，朝外
  const normals: THREE.Vector3[][] = ring.map((r, k) =>
    r.map((p, j) => {
      const a = (ring[Math.max(0, k - 1)] as THREE.Vector3[])[j] as THREE.Vector3;
      const c = (ring[Math.min(K - 1, k + 1)] as THREE.Vector3[])[j] as THREE.Vector3;
      const tz = new THREE.Vector3().subVectors(c, a);
      let jp = (j + 1) % m;
      let jm = (j - 1 + m) % m;
      // 跳过重合的点（收拢的截面）
      for (let s = 0; s < 3 && (r[jp] as THREE.Vector3).distanceToSquared(p) < 1e-10; s++) jp = (jp + 1) % m;
      for (let s = 0; s < 3 && (r[jm] as THREE.Vector3).distanceToSquared(p) < 1e-10; s++) jm = (jm - 1 + m) % m;
      const tr = new THREE.Vector3().subVectors(r[jp] as THREE.Vector3, r[jm] as THREE.Vector3);
      const nrm = new THREE.Vector3().crossVectors(tr, tz);
      const out = new THREE.Vector3(p.x, p.y - (cy[k] as number), 0);
      if (nrm.lengthSq() < 1e-12) nrm.copy(out);
      if (nrm.dot(out) < 0) nrm.negate();
      return nrm.lengthSq() > 1e-12 ? nrm.normalize() : new THREE.Vector3(0, 1, 0);
    }),
  );
  const bandOf = (j: number) => (j < n - 1 ? j : 2 * n - 3 - j);
  const sgn = flip ? -1 : 1;
  for (let k = 0; k < K - 1; k++) {
    const r0 = ring[k] as THREE.Vector3[];
    const r1 = ring[k + 1] as THREE.Vector3[];
    for (let j = 0; j < m; j++) {
      const j1 = (j + 1) % m;
      const A = r0[j] as THREE.Vector3;
      const B = r0[j1] as THREE.Vector3;
      const C = r1[j1] as THREE.Vector3;
      const D = r1[j] as THREE.Vector3;
      const nA = (normals[k] as THREE.Vector3[])[j] as THREE.Vector3;
      const nB = (normals[k] as THREE.Vector3[])[j1] as THREE.Vector3;
      const nC = (normals[k + 1] as THREE.Vector3[])[j1] as THREE.Vector3;
      const nD = (normals[k + 1] as THREE.Vector3[])[j] as THREE.Vector3;
      const xc = (A.x + B.x + C.x + D.x) / 4;
      const yc = (A.y + B.y + C.y + D.y) / 4;
      const avg = new THREE.Vector3().add(nA).add(nB).add(nC).add(nD).normalize();
      const mat = classify({ band: bandOf(j), z0: A.z, z1: D.z, zc: (A.z + D.z) / 2, xc, yc, ny: avg.y * sgn, nz: avg.z * sgn, right: j < n - 1 });
      if (!mat) continue;
      // 绕序：面法线与（翻转后的）平均法线同向
      const f = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(D, A));
      const [mA, mB, mC, mD] = flip ? [nA, nB, nC, nD].map((v) => v.clone().negate()) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] : [nA, nB, nC, nD];
      if (f.dot(avg) * sgn >= 0) {
        b.tri(mat, A, B, D, mA, mB, mD);
        b.tri(mat, B, C, D, mB, mC, mD);
      } else {
        b.tri(mat, A, D, B, mA, mD, mB);
        b.tri(mat, B, D, C, mB, mD, mC);
      }
    }
  }
  // 封口
  const cap = (k: number, mat: Mat, dir: number) => {
    const r = ring[k] as THREE.Vector3[];
    const c = new THREE.Vector3();
    for (const p of r) c.add(p);
    c.divideScalar(r.length);
    const nn = new THREE.Vector3(0, 0, dir * sgn);
    for (let j = 0; j < m; j++) {
      const a = r[j] as THREE.Vector3;
      const bb = r[(j + 1) % m] as THREE.Vector3;
      const f = new THREE.Vector3().subVectors(a, c).cross(new THREE.Vector3().subVectors(bb, c));
      if (f.lengthSq() < 1e-14) continue;
      if (f.z * dir * sgn >= 0) b.tri(mat, c, a, bb, nn, nn, nn);
      else b.tri(mat, c, bb, a, nn, nn, nn);
    }
  };
  if (caps.rear) cap(0, caps.rear, -1);
  if (caps.front) cap(K - 1, caps.front, 1);
}

/** 分段线性插值：pts 为 (x, y) 关键点（按 x 升序） */
export function pw(pts: Array<[number, number]>, x: number): number {
  if (!pts.length) return 0;
  if (x <= (pts[0] as [number, number])[0]) return (pts[0] as [number, number])[1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i] as [number, number];
    if (x <= x1) {
      const [x0, y0] = pts[i - 1] as [number, number];
      const t = (x - x0) / Math.max(1e-9, x1 - x0);
      // 平滑插值，车身线条没有折角
      const s = t * t * (3 - 2 * t);
      return y0 + (y1 - y0) * (0.35 * t + 0.65 * s);
    }
  }
  return (pts[pts.length - 1] as [number, number])[1];
}

export function smooth01(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
}

/** 截面采样位置：均匀间隔，再加上关键位置（轮拱、门缝、车窗边、风挡）两侧各一个点，特征更清楚 */
export function stations(z0: number, z1: number, step: number, keys: number[], eps = 0.012): number[] {
  const out = new Set<number>();
  for (let z = z0; z < z1 - 1e-6; z += step) out.add(+z.toFixed(4));
  out.add(+z1.toFixed(4));
  for (const k of keys) {
    for (const d of [-eps, 0, eps]) {
      const z = k + d;
      if (z > z0 && z < z1) out.add(+z.toFixed(4));
    }
  }
  return [...out].sort((a, b) => a - b);
}
