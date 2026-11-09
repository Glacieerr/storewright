import type { PathLike, PathState, Pt } from './index';
import { angDiff } from './geom';

/**
 * 带速度剖面的路径（第一部分 Storewright 停车场的 TimedPath）：长线段切成不超过 3 米的小段；每个顶点的速度受该段限速、
 * 转弯处的侧向加速度（v ≤ √(a·R)）、前后的加速度和减速度约束（正向、反向各扫一遍），段内匀加速，
 * 所以车辆会起步、刹车、过弯减速。车头朝向在顶点处平滑过渡，前轮转角 δ = atan(轴距 × 曲率)。
 * 倒车（reverse）时车头与行进方向相反。duration 是走完全程的时间；at(τ) 给位置、朝向、速度、加速度、转角和走过的距离。
 */

/** 车辆的动力学参数（米、秒）：最大加速度、减速度、过弯侧向加速度，起点 / 终点速度（'cap' = 该段限速）、轴距 */
export interface Dynamics {
  accel?: number;
  decel?: number;
  lat?: number;
  v0?: number | 'cap';
  v1?: number | 'cap';
  wheelbase?: number;
}

const CAR_DYN = { accel: 2.2, decel: 3, lat: 2, wheelbase: 2.7 };
const PIECE = 3;

/** A polyline driven with speed limits, acceleration, braking and lateral-acceleration limits in bends; sample with at(t). 按动力学限制走完一条折线的路径。 */
export class TimedPath implements PathLike {
  readonly duration: number;
  readonly length: number;
  readonly reverse: boolean;
  /** 点数；坐标、累计时刻、累计距离、顶点速度、每一小段的朝向都存在 Float64Array 里（pts、cumT、cumD 第一次读时才生成普通数组） */
  private readonly n: number;
  private readonly X: Float64Array;
  private readonly Z: Float64Array;
  private readonly T: Float64Array;
  private readonly D: Float64Array;
  private readonly v: Float64Array;
  private readonly h: Float64Array;
  private readonly wheelbase: number;
  private P?: Pt[];
  private Tm?: number[];
  private Dm?: number[];

  constructor(raw: readonly Pt[], speedAt: number | ((a: Pt, b: Pt) => number), reverse = false, dyn: Dynamics = {}) {
    const d = { ...CAR_DYN, ...dyn };
    const speed = typeof speedAt === 'number' ? () => speedAt : speedAt;
    this.reverse = reverse;
    this.wheelbase = d.wheelbase;
    // 1. 切成小段，记下每段的限速（重合的点跳过）
    const xs: number[] = [];
    const zs: number[] = [];
    const cap: number[] = [];
    // 上一个点（交给限速函数的 a 和原来一样是上一个点的坐标）
    let last: Pt | undefined;
    if (raw.length) {
      xs.push((raw[0] as Pt).x);
      zs.push((raw[0] as Pt).z);
      last = { x: (raw[0] as Pt).x, z: (raw[0] as Pt).z };
    }
    for (let i = 1; i < raw.length; i++) {
      const a = last as Pt;
      const b = raw[i] as Pt;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-6) continue;
      const n = Math.max(1, Math.ceil(len / PIECE));
      const limit = Math.max(0.3, speed(a, b));
      let px = a.x;
      let pz = a.z;
      for (let k = 1; k <= n; k++) {
        px = a.x + ((b.x - a.x) * k) / n;
        pz = a.z + ((b.z - a.z) * k) / n;
        xs.push(px);
        zs.push(pz);
        cap.push(limit);
      }
      last = { x: px, z: pz };
    }
    if (xs.length === 1) {
      xs.push(xs[0] as number);
      zs.push(zs[0] as number);
      cap.push(0.3);
    }
    const n = xs.length;
    const X = Float64Array.from(xs);
    const Z = Float64Array.from(zs);
    const cumD = new Float64Array(Math.max(1, n));
    const len = new Float64Array(Math.max(0, n - 1));
    const head = new Float64Array(Math.max(0, n - 1));
    for (let i = 1; i < n; i++) {
      const dx = (X[i] as number) - (X[i - 1] as number);
      const dz = (Z[i] as number) - (Z[i - 1] as number);
      const l = Math.hypot(dx, dz);
      len[i - 1] = l;
      head[i - 1] = l > 1e-9 ? Math.atan2(dx, dz) : i >= 2 ? (head[i - 2] as number) : 0;
      cumD[i] = (cumD[i - 1] as number) + l;
    }
    this.length = n ? (cumD[n - 1] as number) : 0;
    this.h = head;
    // 2. 顶点限速：相邻两段的限速、转弯半径
    const vmax: number[] = new Array<number>(n).fill(0);
    for (let j = 0; j < n; j++) {
      let v = Math.min(cap[j - 1] ?? Infinity, cap[j] ?? Infinity);
      if (j > 0 && j < n - 1) {
        const turn = Math.abs(angDiff(head[j - 1] as number, head[j] as number));
        if (turn > 1e-3) {
          const r = ((len[j - 1] as number) + (len[j] as number)) / 2 / turn;
          v = Math.min(v, Math.sqrt(d.lat * r));
        }
      }
      vmax[j] = Number.isFinite(v) ? v : 0.3;
    }
    const v0 = dyn.v0 === 'cap' ? (vmax[0] as number) : (dyn.v0 ?? 0);
    const v1 = dyn.v1 === 'cap' ? (vmax[n - 1] as number) : (dyn.v1 ?? 0);
    vmax[0] = Math.min(vmax[0] as number, v0);
    vmax[n - 1] = Math.min(vmax[n - 1] as number, v1);
    // 3. 正向（加速度）、反向（减速度）各扫一遍
    const v = [...vmax];
    for (let j = 1; j < n; j++) v[j] = Math.min(v[j] as number, Math.sqrt((v[j - 1] as number) ** 2 + 2 * d.accel * (len[j - 1] as number)));
    for (let j = n - 2; j >= 0; j--) v[j] = Math.min(v[j] as number, Math.sqrt((v[j + 1] as number) ** 2 + 2 * d.decel * (len[j] as number)));
    this.v = Float64Array.from(v);
    // 4. 每段匀加速的用时
    const cumT = new Float64Array(Math.max(1, n));
    for (let j = 1; j < n; j++) {
      const a = v[j - 1] as number;
      const b = v[j] as number;
      const l = len[j - 1] as number;
      cumT[j] = (cumT[j - 1] as number) + (l <= 1e-9 ? 0 : (2 * l) / Math.max(0.3, a + b));
    }
    this.duration = n ? (cumT[n - 1] as number) : 0;
    this.n = n;
    this.X = X;
    this.Z = Z;
    this.T = cumT;
    this.D = cumD;
  }

  /** 切成小段以后的点（第一次读时生成，之后是同一份） */
  get pts(): Pt[] {
    if (!this.P) this.P = this.points();
    return this.P;
  }
  /** 每个点的累计时刻、累计距离 */
  get cumT(): number[] {
    return (this.Tm ??= Array.from(this.T));
  }
  get cumD(): number[] {
    return (this.Dm ??= Array.from(this.D));
  }
  /** 点列的一份新拷贝（库里自己用，不留着） */
  points(): Pt[] {
    const P: Pt[] = [];
    for (let i = 0; i < this.n; i++) P.push({ x: this.X[i] as number, z: this.Z[i] as number });
    return P;
  }

  at(tau: number, out: PathState): void {
    const n = this.n;
    if (n === 0) throw new TypeError("Cannot read properties of undefined (reading 'x')");
    const T = this.T;
    const t = Math.min(this.duration, Math.max(0, tau));
    let lo = 1;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((T[mid] as number) < t) lo = mid + 1;
      else hi = mid;
    }
    const i = lo;
    const ax = this.X[i - 1] as number;
    const az = this.Z[i - 1] as number;
    const t0 = T[i - 1] as number;
    const dt = (T[i] as number) - t0;
    const va = this.v[i - 1] as number;
    const vb = this.v[i] as number;
    const l = (this.D[i] as number) - (this.D[i - 1] as number);
    const u = t - t0;
    const acc = dt > 0 ? (vb - va) / dt : 0;
    const sIn = dt > 0 ? Math.min(l, va * u + 0.5 * acc * u * u) : l;
    const k = l > 1e-9 ? sIn / l : 1;
    out.x = ax + ((this.X[i] as number) - ax) * k;
    out.z = az + ((this.Z[i] as number) - az) * k;
    const H = this.h;
    const hp = i >= 2 ? (H[i - 2] as number) : (H[i - 1] as number);
    const hc = H[i - 1] as number;
    const hn = i < H.length ? (H[i] as number) : hc;
    const start = hp + angDiff(hp, hc) / 2;
    const end = hc + angDiff(hc, hn) / 2;
    const hh = start + angDiff(start, end) * k;
    out.heading = this.reverse ? hh + Math.PI : hh;
    out.speed = dt > 0 ? va + acc * u : 0;
    out.accel = acc;
    const kappa = l > 1e-6 ? angDiff(start, end) / l : 0;
    out.steer = Math.atan(this.wheelbase * kappa) * (this.reverse ? -1 : 1);
    out.dist = (this.D[i - 1] as number) + sIn;
  }

  /** 走过 s 米时的时刻（二分） */
  timeAt(s: number): number {
    const target = Math.min(this.length, Math.max(0, s));
    let lo = 0;
    let hi = this.duration;
    const st: PathState = { x: 0, z: 0, heading: 0 };
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      this.at(mid, st);
      if ((st.dist ?? 0) < target) lo = mid;
      else hi = mid;
    }
    return hi;
  }
}

/**
 * 只留时间、距离、速度的 TimedPath（排程器自己用：进场调车只按距离在车道上取位姿，甩挂的一段段动作按距离取牵引车的位姿）。
 * at() 算的 dist、speed、accel 和 TimedPath.at 一字不差；x、z、heading、steer 不写。一个点 24 字节。
 */
export class PathTiming implements PathLike {
  constructor(
    readonly duration: number,
    private readonly n: number,
    private readonly T: Float64Array,
    private readonly D: Float64Array,
    private readonly v: Float64Array,
  ) {}

  at(tau: number, out: PathState): void {
    const n = this.n;
    if (n === 0) throw new TypeError("Cannot read properties of undefined (reading 'x')");
    const T = this.T;
    const t = Math.min(this.duration, Math.max(0, tau));
    let lo = 1;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((T[mid] as number) < t) lo = mid + 1;
      else hi = mid;
    }
    const i = lo;
    const t0 = T[i - 1] as number;
    const dt = (T[i] as number) - t0;
    const va = this.v[i - 1] as number;
    const vb = this.v[i] as number;
    const l = (this.D[i] as number) - (this.D[i - 1] as number);
    const u = t - t0;
    const acc = dt > 0 ? (vb - va) / dt : 0;
    const sIn = dt > 0 ? Math.min(l, va * u + 0.5 * acc * u * u) : l;
    out.speed = dt > 0 ? va + acc * u : 0;
    out.accel = acc;
    out.dist = (this.D[i - 1] as number) + sIn;
  }
}
/** 一条 TimedPath 的时间部分（和它共用数组，不拷贝） */
export function timingOf(p: TimedPath): PathTiming {
  return new PathTiming(p.duration, p['n'], p['T'], p['D'], p['v']);
}

/**
 * 几段路径首尾相接，中间可以停车等待（数字 = 在上一段终点停多少秒）：例如驶出场地时在路口停下让行、等灯，再拐上主路。
 * at() 给出的 dist 是累计距离（跨段相加），铰接车的挂车航向按它取。 * Paths joined end to end with optional stops in between (seconds), e.g. yield or signal waits at the exit.
 */
export class PathChain implements PathLike {
  readonly duration: number;
  readonly length: number;
  private readonly starts: number[] = [];
  private readonly dist0: number[] = [];

  constructor(readonly parts: ReadonlyArray<PathLike | number>) {
    let t = 0;
    let d = 0;
    const st: PathState = { x: 0, z: 0, heading: 0 };
    for (const p of parts) {
      this.starts.push(t);
      this.dist0.push(d);
      if (typeof p === 'number') t += p;
      else {
        t += p.duration;
        p.at(p.duration, st);
        d += st.dist ?? 0;
      }
    }
    this.duration = t;
    this.length = d;
  }

  at(tau: number, out: PathState): void {
    const t = Math.min(this.duration, Math.max(0, tau));
    for (let i = this.parts.length - 1; i >= 0; i--) {
      if (t < (this.starts[i] as number) && i > 0) continue;
      const p = this.parts[i] as PathLike | number;
      if (typeof p === 'number') {
        // 停车等待：停在上一段的终点
        const prev = this.parts[i - 1];
        if (prev && typeof prev !== 'number') prev.at(prev.duration, out);
        out.speed = 0;
        out.accel = 0;
        out.dist = this.dist0[i] as number;
        return;
      }
      p.at(t - (this.starts[i] as number), out);
      out.dist = (out.dist ?? 0) + (this.dist0[i] as number);
      return;
    }
  }

  /** 第 i 段（含等待）开始的时刻 */
  startOf(i: number): number {
    return this.starts[i] ?? this.duration;
  }
}
