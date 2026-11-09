import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * 车辆建模工具（第一部分 Storewright 的放样建模，决策记录 0018）：车身、玻璃、饰条、灯等部件收集成两份——
 * 「车漆」（按实例着色）和「细节」（固定的顶点色）；最后合成一个几何体，用 aPaint 区分（1 = 车漆、0 = 细节），
 * 着色器里只有车漆乘实例颜色（车窗、灯、轮胎不跟着车身变色），aRough 是每个顶点的粗糙度（玻璃亮、轮胎哑）。
 *
 * 主要的建模方式是放样（loft）：沿车长方向排一串截面，截面是车身右半边从底部中点绕到顶部中点的折线，
 * 左半边镜像；相邻截面之间的每个四边形按位置分类成车漆、玻璃、饰条等（车窗、门缝、轮拱都这样得到），法线按网格解析计算。
 *
 * 建模坐标沿用第一部分：车头朝 +Z、y 向上；finish() 换成本项目零件的坐标：原点在零件车尾、车头朝 +x、地面 y = 0。
 * coarse = true 时是远处用的简模：圆角换成直角、圆柱段数减少、细管不画。
 */

export type Mat = 'paint' | 'glass' | 'trim' | 'chrome' | 'light' | 'tail' | 'amber' | 'plate' | 'rubber' | 'accent' | 'white' | 'wood' | 'canvas' | 'deck' | 'cushion' | 'navy' | 'alu' | 'stripe' | 'dark';

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
  stripe: new THREE.Color('#2a78d6'),
  dark: new THREE.Color('#3a3d42'),
};

/** 每种材质的粗糙度（没有环境贴图，金属度一律很低；玻璃、车漆亮一点，太阳底下有高光） */
export const MAT_ROUGH: Record<Mat, number> = {
  paint: 0.36,
  glass: 0.08,
  trim: 0.72,
  chrome: 0.3,
  light: 0.2,
  tail: 0.3,
  amber: 0.3,
  plate: 0.6,
  rubber: 0.92,
  accent: 0.45,
  white: 0.45,
  wood: 0.8,
  canvas: 0.9,
  deck: 0.8,
  cushion: 0.85,
  navy: 0.5,
  alu: 0.35,
  stripe: 0.4,
  dark: 0.7,
};

const GLASS_TOP = new THREE.Color('#6f8fa3');
const _c = new THREE.Color();

export class MeshBuilder {
  private readonly paint = { pos: [] as number[], nrm: [] as number[] };
  private readonly detail = { pos: [] as number[], nrm: [] as number[], col: [] as number[], rough: [] as number[] };
  /** 玻璃顶点色的渐变范围（上亮下暗，像映着天空） */
  glassY0 = 0.8;
  glassY1 = 1.6;
  /** 远处的简模 */
  coarse = false;
  /** 某些材质换成别的颜色（例如公司彩条、房车的彩条） */
  custom = new Map<Mat, THREE.Color>();

  private colorFor(mat: Exclude<Mat, 'paint'>, y: number, out: THREE.Color): THREE.Color {
    const cc = this.custom.get(mat);
    if (cc) return out.copy(cc);
    if (mat === 'glass') {
      const k = Math.min(1, Math.max(0, (y - this.glassY0) / Math.max(0.01, this.glassY1 - this.glassY0)));
      return out.copy(MAT_COLOR.glass).lerp(GLASS_TOP, k * 0.75);
    }
    return out.copy(MAT_COLOR[mat]);
  }

  private push(mat: Mat, p: THREE.Vector3, n: THREE.Vector3, color?: THREE.Color): void {
    if (mat === 'paint') {
      this.paint.pos.push(p.x, p.y, p.z);
      this.paint.nrm.push(n.x, n.y, n.z);
      return;
    }
    const d = this.detail;
    d.pos.push(p.x, p.y, p.z);
    d.nrm.push(n.x, n.y, n.z);
    const cc = color ?? this.colorFor(mat, p.y, _c);
    d.col.push(cc.r, cc.g, cc.b);
    d.rough.push(MAT_ROUGH[mat]);
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
    this.push(mat, a, n0, color);
    this.push(mat, b, n1, color);
    this.push(mat, c, n2, color);
  }

  /** 把一个现成的几何体（已经放在建模坐标里）并进来 */
  part(geo: THREE.BufferGeometry, mat: Mat, color?: THREE.Color): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const pv = new THREE.Vector3();
    const nv = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      pv.set(p.getX(i), p.getY(i), p.getZ(i));
      nv.set(n.getX(i), n.getY(i), n.getZ(i));
      this.push(mat, pv, nv, color);
    }
  }

  box(mat: Mat, w: number, h: number, d: number, x: number, y: number, z: number, opts: { r?: number; rx?: number; ry?: number; rz?: number; color?: THREE.Color } = {}): void {
    // 小部件的圆角只用一段（看起来是倒角），省三角形；很薄的部件、简模不倒角
    const min = Math.min(w, h, d);
    const g = !this.coarse && opts.r && opts.r > 0 && min > 0.035 ? new RoundedBoxGeometry(w, h, d, min < 0.25 ? 1 : 2, Math.min(opts.r, w / 2, h / 2, d / 2)) : new THREE.BoxGeometry(w, h, d);
    if (opts.rx) g.rotateX(opts.rx);
    if (opts.ry) g.rotateY(opts.ry);
    if (opts.rz) g.rotateZ(opts.rz);
    g.translate(x, y, z);
    this.part(g, mat, opts.color);
  }

  /** 圆柱：axis 为 'x' | 'y' | 'z' */
  cyl(mat: Mat, r0: number, r1: number, len: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'y', seg = 12, color?: THREE.Color): void {
    const g = new THREE.CylinderGeometry(r1, r0, len, this.coarse ? Math.min(seg, 7) : seg);
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.part(g, mat, color);
  }

  /** 沿一串点的细管（扶手、栏杆、排气管弯头）；简模不画 */
  tube(mat: Mat, pts: THREE.Vector3[], r: number, seg = 6, color?: THREE.Color): void {
    if (pts.length < 2 || this.coarse) return;
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const g = new THREE.TubeGeometry(curve, Math.max(4, pts.length * 4), r, seg, false);
    this.part(g, mat, color);
  }

  /** 拉伸的平面形状（翼子板、轮拱、侧板）：shape 在 (z, y) 平面里，沿 x 拉伸 depth、从 x0 开始 */
  extrudeZY(mat: Mat, shape: THREE.Shape, depth: number, x0: number, opts: { bevel?: number; curve?: number } = {}): void {
    const bevel = this.coarse ? 0 : (opts.bevel ?? 0);
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: this.coarse ? 5 : (opts.curve ?? 12) });
    // 形状的 x 是建模坐标的 z，形状的 y 是 y，拉伸方向（形状的 z）是建模坐标的 x
    g.rotateY(-Math.PI / 2);
    g.translate(x0 + depth, 0, 0);
    this.part(g, mat);
  }

  /** 车漆、细节两份几何体（建模坐标） */
  build(): { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
    const paint = new THREE.BufferGeometry();
    paint.setAttribute('position', new THREE.Float32BufferAttribute(this.paint.pos, 3));
    paint.setAttribute('normal', new THREE.Float32BufferAttribute(this.paint.nrm, 3));
    const detail = new THREE.BufferGeometry();
    detail.setAttribute('position', new THREE.Float32BufferAttribute(this.detail.pos, 3));
    detail.setAttribute('normal', new THREE.Float32BufferAttribute(this.detail.nrm, 3));
    detail.setAttribute('color', new THREE.Float32BufferAttribute(this.detail.col, 3));
    detail.setAttribute('aRough', new THREE.Float32BufferAttribute(this.detail.rough, 1));
    return { paint, detail };
  }

  /**
   * 合成一个几何体并换到零件坐标：建模坐标的 z = zRear 落到 x = 0（车尾）、车头朝 +x；
   * 车漆的顶点色是白色（乘实例颜色）、aPaint = 1，细节的 aPaint = 0。
   */
  finish(zRear: number): THREE.BufferGeometry {
    return toPart(mergeLayers(this.paint, this.detail), zRear);
  }

  /** 三角形数（统计用） */
  get triangles(): number {
    return (this.paint.pos.length + this.detail.pos.length) / 9;
  }
}

function mergeLayers(paint: { pos: number[]; nrm: number[] }, detail: { pos: number[]; nrm: number[]; col: number[]; rough: number[] }): THREE.BufferGeometry {
  const np = paint.pos.length / 3;
  const nd = detail.pos.length / 3;
  const n = np + nd;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const mask = new Float32Array(n);
  const rough = new Float32Array(n);
  pos.set(paint.pos, 0);
  pos.set(detail.pos, np * 3);
  nrm.set(paint.nrm, 0);
  nrm.set(detail.nrm, np * 3);
  col.fill(1, 0, np * 3);
  col.set(detail.col, np * 3);
  mask.fill(1, 0, np);
  rough.fill(MAT_ROUGH.paint, 0, np);
  rough.set(detail.rough, np);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPaint', new THREE.BufferAttribute(mask, 1));
  g.setAttribute('aRough', new THREE.BufferAttribute(rough, 1));
  return g;
}

/** 建模坐标（车头 +Z）→ 零件坐标（车头 +x、原点在车尾）：绕 y 转 90°，再把 zRear 挪到 x = 0 */
export function toPart(g: THREE.BufferGeometry, zRear: number): THREE.BufferGeometry {
  g.rotateY(Math.PI / 2);
  g.translate(-zRear, 0, 0);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/**
 * 不是放样出来的旧几何体（火车、船、飞机、机场设备）补上 aPaint、aRough：整个几何体都乘实例颜色（和原来一样）。
 * 和车辆共用一个材质的几何体都要有这两个属性。
 */
export function ensureSurface(g: THREE.BufferGeometry, paint = 1, rough = 0.6): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  if (!g.getAttribute('aPaint')) g.setAttribute('aPaint', new THREE.BufferAttribute(new Float32Array(n).fill(paint), 1));
  if (!g.getAttribute('aRough')) g.setAttribute('aRough', new THREE.BufferAttribute(new Float32Array(n).fill(rough), 1));
  if (!g.getAttribute('color')) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return g;
}

/**
 * 让一个 MeshStandardMaterial 认 aPaint、aRough：实例颜色只乘车漆，粗糙度按顶点。
 * 区域车辆层自己用；港口、机场的外来货车（ops/extTrucks.ts）想要同样的效果，把它们的材质也过一遍就行。
 */
export function usePaintMask<T extends THREE.MeshStandardMaterial>(mat: T): T {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPaint;\nattribute float aRough;\nvarying float vRough;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vRough = aRough;')
      .replace(
        '#include <color_vertex>',
        `#if defined( USE_COLOR_ALPHA )
  vColor = vec4( 1.0 );
#elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor = vec3( 1.0 );
#endif
#ifdef USE_COLOR
  vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.xyz *= mix( vec3( 1.0 ), instanceColor.xyz, aPaint );
#endif`,
      );
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vRough;').replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRough;');
  };
  mat.customProgramCacheKey = () => 'vehicle-paint-mask';
  return mat;
}

/** 截面：z 位置与右半边的点（x ≥ 0），从底部中点（x = 0）绕到顶部中点（x = 0） */
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
  const ring: THREE.Vector3[][] = sections.map((s) => {
    const r: THREE.Vector3[] = [];
    for (let j = 0; j < n; j++) r.push(new THREE.Vector3((s.pts[j] as [number, number])[0], (s.pts[j] as [number, number])[1], s.z));
    for (let j = n - 2; j >= 1; j--) r.push(new THREE.Vector3(-(s.pts[j] as [number, number])[0], (s.pts[j] as [number, number])[1], s.z));
    return r;
  });
  const K = ring.length;
  const cy = ring.map((r) => r.reduce((a, p) => a + p.y, 0) / r.length);
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
      // 两条边都缩成一点的四边形（收拢处）不画
      if (A.distanceToSquared(B) < 1e-12 && D.distanceToSquared(C) < 1e-12) continue;
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
      const [mA, mB, mC, mD] = flip ? ([nA, nB, nC, nD].map((v) => v.clone().negate()) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]) : [nA, nB, nC, nD];
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

/** 分段插值：pts 为 (x, y) 关键点（按 x 升序），段内平滑，车身线条没有折角 */
export function pw(pts: Array<[number, number]>, x: number): number {
  if (!pts.length) return 0;
  if (x <= (pts[0] as [number, number])[0]) return (pts[0] as [number, number])[1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i] as [number, number];
    if (x <= x1) {
      const [x0, y0] = pts[i - 1] as [number, number];
      const t = (x - x0) / Math.max(1e-9, x1 - x0);
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

/**
 * 截面采样位置：均匀间隔，再加上关键位置（轮拱、门缝、车窗边、风挡）两侧各一个点，特征更清楚。
 * coarse（简模）：间隔放大、关键位置只取本身。
 */
export function stations(z0: number, z1: number, step: number, keys: number[], eps = 0.012, coarse = false): number[] {
  const out = new Set<number>();
  const st = coarse ? step * 3.5 : step;
  for (let z = z0; z < z1 - 1e-6; z += st) out.add(+z.toFixed(4));
  out.add(+z1.toFixed(4));
  for (const k of keys) {
    for (const d of coarse ? [0] : [-eps, 0, eps]) {
      const z = k + d;
      if (z > z0 && z < z1) out.add(+z.toFixed(4));
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** 圆角矩形截面（右半边）：底部中点 → 底板边 → 轮罩 → 侧壁 → 顶角圆弧 → 顶部中点；点数固定 */
export function tallSection(z: number, hw: number, yB: number, ySide: number, yTop: number, rTop: number, crown: number, levels: number[]): Section {
  const r = Math.min(rTop, hw * 0.9, Math.max(0.02, (yTop - ySide) * 0.45));
  const pts: Array<[number, number]> = [
    [0, yB],
    [Math.max(0.02, hw - 0.2), yB],
    [Math.max(0.02, hw - 0.2), ySide],
    [hw - 0.015, ySide],
  ];
  const lo = ySide + 0.02;
  const hi = Math.max(lo + 0.002 * (levels.length + 1), yTop - r);
  let prev = ySide;
  levels.forEach((y, i) => {
    const yy = Math.max(prev + 0.001, Math.min(hi - (levels.length - i) * 0.002, Math.max(lo + i * 0.002, y)));
    pts.push([hw, yy]);
    prev = yy;
  });
  for (const a of [0.3, 0.75, 1.2]) pts.push([hw - r + r * Math.cos(a), Math.max(prev + 0.001, yTop - r + r * Math.sin(a))]);
  pts.push([Math.max(0.01, (hw - r) * 0.5), yTop + crown * 0.75], [0, yTop + crown]);
  return { z, pts };
}

/** 圆角矩形截面各段的编号：0–2 底盘和轮罩，3 … 3+L 侧壁（L 为侧壁高度数），4+L … 5+L 顶角，6+L 起车顶 */
export const sideBand = (q: QuadInfo, levels: readonly number[]) => q.band >= 3 && q.band <= 3 + levels.length;
export const roofBand = (q: QuadInfo, levels: readonly number[]) => q.band >= 6 + levels.length;

/** 轮拱：车轴 axles 处侧面下沿抬到轮子上面 */
export function arches(axles: number[], wheelR: number, archR: number, sill: number, z: number): number {
  let y = sill;
  for (const az of axles) {
    const d = Math.abs(z - az);
    if (d < archR) y = Math.max(y, wheelR + Math.sqrt(archR * archR - d * d) * 0.97);
  }
  return y;
}

export interface Rect {
  z0: number;
  z1: number;
  y0: number;
  y1: number;
}
export const inRect = (q: QuadInfo, r: Rect) => q.zc > r.z0 && q.zc < r.z1 && q.yc > r.y0 && q.yc < r.y1;

/**
 * 简模里合进车身的车轮（建模坐标，车轴沿 x）：轮胎是低段数的圆柱，外侧一个浅色轮毂面；dual = 双胎（两只并排）。
 * 精模的车轮单独实例化（会转、会打方向），见 wheels.ts。
 */
export function coarseWheel(b: MeshBuilder, x: number, z: number, r: number, w: number, dual = false): void {
  const parts = dual ? [x - Math.sign(x || 1) * w * 0.55, x + Math.sign(x || 1) * w * 0.55] : [x];
  for (const cx of parts) {
    b.cyl('rubber', r, r, w, cx, r, z, 'x', 8);
    b.cyl('chrome', r * 0.55, r * 0.55, w + 0.02, cx, r, z, 'x', 6, new THREE.Color('#9aa0a6'));
  }
}
