import * as THREE from 'three';

/**
 * 设施作业动画（港口、机场、物流园、门店收货区）共用的小工具：
 * - Pool：一种零件的实例池，每帧 begin() → put() 若干个 → end()；
 * - Poly：折线路径，按走过的距离取位置和朝向；
 * - 缓动、插值、固定的伪随机数。
 *
 * 朝向和区域里的车辆一致：模型车头朝 +x，yaw = −atan2(dz, dx)。
 */
export class Pool {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YZX');
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly c = new THREE.Color();

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly capacity: number, name: string, shadow = true) {
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = shadow;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.name = name;
  }

  begin(): void {
    this.n = 0;
  }

  /** 放一个实例：位置、朝向（yaw 绕 y，pitch 绕本地 z，roll 绕本地 x）、缩放、颜色 */
  put(x: number, y: number, z: number, yaw = 0, pitch = 0, sx = 1, sy = 1, sz = 1, color?: THREE.ColorRepresentation, roll = 0): void {
    if (this.n >= this.capacity) return;
    this.e.set(roll, yaw, pitch);
    this.q.setFromEuler(this.e);
    this.p.set(x, y, z);
    this.s.set(sx, sy, sz);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(this.n, this.m);
    this.mesh.setColorAt(this.n, this.c.set(color ?? '#ffffff'));
    this.n++;
  }

  /** 两点之间拉一根细杆（钢丝绳、拉杆）：粗细 r */
  rod(a: THREE.Vector3Like, b: THREE.Vector3Like, r: number, color?: THREE.ColorRepresentation): void {
    if (this.n >= this.capacity) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz) || 0.001;
    this.p.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    this.q.setFromUnitVectors(UP, this.s.set(dx / len, dy / len, dz / len));
    this.s.set(r, len, r);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(this.n, this.m);
    this.mesh.setColorAt(this.n, this.c.set(color ?? '#2b2b2b'));
    this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.boundingSphere = null;
  }
}
const UP = new THREE.Vector3(0, 1, 0);

/** 细杆的几何体：沿 y、长 1、半径 1（Pool.rod 按两点缩放） */
export const rodGeometry = (): THREE.BufferGeometry => new THREE.CylinderGeometry(1, 1, 1, 6);

export interface At {
  x: number;
  z: number;
  /** 前进方向的 yaw（区域里的约定：yaw = −atan2(dz, dx)） */
  yaw: number;
}
/** 折线路径：按走过的距离取位置和朝向 */
export class Poly {
  readonly pts: { x: number; z: number }[];
  readonly cum: number[];
  readonly len: number;
  constructor(pts: readonly { x: number; z: number }[]) {
    const clean: { x: number; z: number }[] = [];
    for (const p of pts) {
      const last = clean[clean.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.z - last.z) > 0.01) clean.push({ x: p.x, z: p.z });
    }
    if (clean.length === 1) clean.push({ x: (clean[0] as { x: number }).x + 0.01, z: (clean[0] as { z: number }).z });
    this.pts = clean;
    this.cum = [0];
    for (let i = 1; i < clean.length; i++) this.cum.push((this.cum[i - 1] as number) + Math.hypot((clean[i] as { x: number }).x - (clean[i - 1] as { x: number }).x, (clean[i] as { z: number }).z - (clean[i - 1] as { z: number }).z));
    this.len = this.cum[this.cum.length - 1] as number;
  }
  at(s: number, out: At = { x: 0, z: 0, yaw: 0 }): At {
    const n = this.pts.length;
    const d = Math.max(0, Math.min(this.len, s));
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((this.cum[mid] as number) <= d) lo = mid;
      else hi = mid;
    }
    const a = this.pts[lo] as { x: number; z: number };
    const b = this.pts[hi] as { x: number; z: number };
    const seg = (this.cum[hi] as number) - (this.cum[lo] as number) || 1;
    const k = (d - (this.cum[lo] as number)) / seg;
    out.x = a.x + (b.x - a.x) * k;
    out.z = a.z + (b.z - a.z) * k;
    out.yaw = -Math.atan2(b.z - a.z, b.x - a.x);
    return out;
  }
}

/** 圆角折线：转弯处插一段圆弧（半径 r），车辆转弯更像真的 */
export function rounded(pts: readonly { x: number; z: number }[], r: number, steps = 6): { x: number; z: number }[] {
  if (pts.length < 3) return pts.map((p) => ({ x: p.x, z: p.z }));
  const out: { x: number; z: number }[] = [{ x: (pts[0] as { x: number }).x, z: (pts[0] as { z: number }).z }];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1] as { x: number; z: number };
    const b = pts[i] as { x: number; z: number };
    const c = pts[i + 1] as { x: number; z: number };
    const l1 = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const l2 = Math.hypot(c.x - b.x, c.z - b.z) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const p1 = { x: b.x - ((b.x - a.x) / l1) * rr, z: b.z - ((b.z - a.z) / l1) * rr };
    const p2 = { x: b.x + ((c.x - b.x) / l2) * rr, z: b.z + ((c.z - b.z) / l2) * rr };
    for (let k = 0; k <= steps; k++) {
      const f = k / steps;
      const u = 1 - f;
      out.push({ x: u * u * p1.x + 2 * u * f * b.x + f * f * p2.x, z: u * u * p1.z + 2 * u * f * b.z + f * f * p2.z });
    }
  }
  out.push({ x: (pts[pts.length - 1] as { x: number }).x, z: (pts[pts.length - 1] as { z: number }).z });
  return out;
}

/** 带引入段的路径：起点前面沿第一段的反方向延长 lead 米（拖挂的板车、车厢起步前就排在那里） */
export function leadIn(pts: readonly { x: number; z: number }[], lead: number): { x: number; z: number }[] {
  const a = pts[0] as { x: number; z: number };
  const b = pts[1] as { x: number; z: number };
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return [{ x: a.x - ((b.x - a.x) / l) * lead, z: a.z - ((b.z - a.z) / l) * lead }, ...pts.map((p) => ({ x: p.x, z: p.z }))];
}

export const clamp01 = (f: number): number => (f < 0 ? 0 : f > 1 ? 1 : f);
/** 匀加速 → 匀速 → 匀减速：时间比例 f → 路程比例（加速、减速各占 a） */
export const cruise = (f: number, a = 0.18): number => {
  const x = clamp01(f);
  const v = 1 / (1 - a);
  if (x < a) return (v / (2 * a)) * x * x;
  if (x > 1 - a) return 1 - (v / (2 * a)) * (1 - x) * (1 - x);
  return v * (x - a / 2);
};
/** 平滑的加速和减速（smoothstep） */
export const ease = (f: number): number => {
  const x = clamp01(f);
  return x * x * (3 - 2 * x);
};
export const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;
/** 0 → 1 的进度：t 在 [t0, t1] 里的位置 */
export const prog = (t: number, t0: number, t1: number): number => clamp01((t - t0) / Math.max(1e-6, t1 - t0));

/**
 * 分段的计算：每一步之间可以停下来。三维层在主线程里把一天的设施作业分成很多小段排，段与段之间让出主线程
 * （画面接着动、时钟接着走）；先后和一口气排完时一样，结果也一样。
 */
export type Steps<T = void> = Generator<void, T, void>;
/** 把分段的计算一口气算完（同步的调用方：Node 里的脚本、单元测试、setDay 这类老接口） */
export function drain<T>(g: Steps<T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** 固定的伪随机数（同一个种子每次一样） */
export function rng(seed: number): () => number {
  let s = Math.abs(Math.floor(seed)) % 2147483646 || 1;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** 集装箱的颜色（各家公司的箱，背景）和本店的箱（醒目的蓝色） */
export const BOX_COLORS = ['#b03a2e', '#2471a3', '#1e8449', '#ca6f1e', '#7d3c98', '#5d6d7e', '#a04000', '#2e86c1', '#d4ac0d', '#117a65', '#922b21', '#e5e7e9'];
export const STORE_BOX = '#1d6fe0';
export const REEFER_BOX = '#f2f3f4';

/** 集装箱（40 尺，长 12.19、宽 2.44、高 2.59）：箱体 + 角柱 + 门端锁杆 + 顶面的凹槽；原点在底面中心，长边沿 x */
export function containerGeometry(boxPart: (w: number, h: number, d: number, c: string, x?: number, y?: number, z?: number) => THREE.BufferGeometry, merge: (p: THREE.BufferGeometry[]) => THREE.BufferGeometry): THREE.BufferGeometry {
  const L = 12.19;
  const W = 2.44;
  const H = 2.59;
  const parts = [boxPart(L - 0.3, H - 0.16, W - 0.08, '#ffffff', 0, 0.08, 0)];
  // 角柱和上下边梁（深一点的同色，用顶点色乘出来：画成 0.82 的灰）
  for (const x of [-L / 2 + 0.12, L / 2 - 0.12]) for (const z of [-W / 2 + 0.1, W / 2 - 0.1]) parts.push(boxPart(0.24, H, 0.2, '#d0d0d0', x, 0, z));
  for (const y of [0, H - 0.14]) for (const z of [-W / 2 + 0.06, W / 2 - 0.06]) parts.push(boxPart(L, 0.14, 0.12, '#d0d0d0', 0, y, z));
  // 瓦楞：侧面每 0.6 米一道竖条
  for (let x = -L / 2 + 0.6; x < L / 2 - 0.5; x += 0.6) for (const z of [-W / 2 - 0.005, W / 2 + 0.005]) parts.push(boxPart(0.14, H - 0.4, 0.03, '#e2e2e2', x, 0.2, z));
  // 门端（+x）：四根锁杆
  for (const z of [-0.85, -0.35, 0.35, 0.85]) parts.push(boxPart(0.04, H - 0.3, 0.06, '#9a9a9a', L / 2 + 0.01, 0.15, z));
  return merge(parts);
}
