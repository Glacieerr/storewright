import { roundCorners, TimedPath, type Dynamics, type PathState, type Pt } from './lot';
import { SEMI } from './vehicles';

/**
 * 铰接半挂车的运动学（决策记录 0013）：
 * - 前进：牵引销（≈ 牵引车后轴）沿路径行驶，挂车航向按 dθ挂/ds = sin(θ牵 − θ挂) / L 沿路径积分，
 *   转弯时挂车切内侧（内轮差），出弯后慢慢摆正；
 * - 倒车：挂车后轴沿规划好的路径退入卸货口，挂车航向就是这条路径的方向，牵引销在挂车前方 L 处，
 *   牵引车航向取牵引销的运动方向（牵引车后轴的速度总是沿车身方向）。
 * 两种情况都按时间确定，可以拖动时间轴。
 */

export interface RigPose extends PathState {
  /** 牵引销位置与牵引车车头朝向（x, z, heading），挂车车头朝向 */
  trailer: number;
  reversing: boolean;
}

const L = SEMI.kingpinToAxle;
export const TRUCK_DYN: Dynamics = { accel: 0.8, decel: 1.6, lat: 1.1, wheelbase: 4.0 };

function angDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export interface RigPath {
  readonly duration: number;
  at(tau: number, out: RigPose): void;
  /** 走完时的状态 */
  end(): RigPose;
}

/** 前进：牵引销沿路径行驶，挂车航向积分 */
export class ForwardRig implements RigPath {
  readonly duration: number;
  private readonly ts: number[] = [];
  private readonly th: number[] = [];
  private readonly s = { x: 0, z: 0, heading: 0 } as PathState;

  constructor(
    readonly path: TimedPath,
    trailer0?: number,
  ) {
    this.duration = path.duration;
    const st = { x: 0, z: 0, heading: 0 } as PathState;
    path.at(0, st);
    let th = trailer0 ?? st.heading;
    let lastDist = 0;
    const step = 0.1;
    for (let t = 0; t <= path.duration + step; t += step) {
      path.at(Math.min(t, path.duration), st);
      const ds = (st.dist ?? 0) - lastDist;
      lastDist = st.dist ?? 0;
      th += (ds / L) * Math.sin(angDiff(th, st.heading));
      this.ts.push(Math.min(t, path.duration));
      this.th.push(th);
    }
  }

  at(tau: number, out: RigPose): void {
    this.path.at(tau, out);
    const t = Math.min(this.duration, Math.max(0, tau));
    const k = Math.min(this.ts.length - 2, Math.max(0, Math.floor(t / 0.1)));
    const a = this.th[k] as number;
    const b = this.th[k + 1] ?? a;
    const f = Math.min(1, Math.max(0, (t - (this.ts[k] as number)) / 0.1));
    out.trailer = a + angDiff(a, b) * f;
    out.reversing = false;
  }

  end(): RigPose {
    const out = { ...this.s, trailer: 0, reversing: false } as RigPose;
    this.at(this.duration, out);
    return out;
  }
}

/** 倒车：挂车后轴沿路径后退，牵引销在挂车前方 */
export class ReverseRig implements RigPath {
  readonly duration: number;
  private readonly a = { x: 0, z: 0, heading: 0 } as PathState;
  private readonly b = { x: 0, z: 0, heading: 0 } as PathState;

  constructor(readonly axlePath: TimedPath) {
    this.duration = axlePath.duration;
  }

  private kingpin(tau: number, st: PathState): { x: number; z: number; th: number } {
    this.axlePath.at(tau, st);
    const th = st.heading;
    return { x: st.x + L * Math.sin(th), z: st.z + L * Math.cos(th), th };
  }

  at(tau: number, out: RigPose): void {
    const t = Math.min(this.duration, Math.max(0, tau));
    const k = this.kingpin(t, this.a);
    const dt = 0.25;
    const t1 = Math.min(this.duration, t + dt);
    const t0 = Math.max(0, t1 - dt);
    const p0 = this.kingpin(t0, this.b);
    const p1 = this.kingpin(t1, this.b);
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    // 倒车时牵引车车头与牵引销的运动方向相反；几乎不动时与挂车一致
    const tractor = Math.hypot(dx, dz) > 1e-3 ? Math.atan2(dx, dz) + Math.PI : k.th;
    out.x = k.x;
    out.z = k.z;
    out.heading = tractor;
    out.trailer = k.th;
    out.speed = this.a.speed ?? 0;
    out.accel = this.a.accel ?? 0;
    out.steer = Math.max(-0.6, Math.min(0.6, angDiff(k.th, tractor)));
    out.dist = this.a.dist ?? 0;
    out.reversing = true;
  }

  end(): RigPose {
    const out = { x: 0, z: 0, heading: 0, trailer: 0, reversing: true } as RigPose;
    this.at(this.duration, out);
    return out;
  }
}

/** 半挂车靠台：前进驶过卸货门 → 倒车让挂车后轴沿圆弧退进卸货口 → 卸货 → 前进驶离 */
export interface SemiDockPlan {
  entry: ForwardRig;
  back: ReverseRig;
  leave: ForwardRig;
  parked: RigPose;
}

export function planSemiDock(opts: {
  startX: number;
  inLane: number;
  outLane: number;
  endX: number;
  serviceX: number;
  zTurn: number;
  doorX: number;
  wallZ: number;
  roadEdgeZ: number;
}): SemiDockPlan {
  const { startX, inLane, outLane, endX, serviceX, zTurn, doorX, wallZ, roadEdgeZ } = opts;
  const speed = (a: Pt, b: Pt) => (Math.max(a.z, b.z) < roadEdgeZ - 1 ? 11 : 4.5);
  // 挂车后轴要在卸货门左侧 22 米处（圆角最多是相邻两段长度的一半，所以留足 2 × 10 米）
  const pullX = doorX - 22 - L;
  const entry = new ForwardRig(
    new TimedPath(
      roundCorners(
        [
          { x: startX, z: inLane },
          { x: serviceX, z: inLane },
          { x: serviceX, z: zTurn },
          { x: pullX, z: zTurn },
        ],
        9,
      ),
      speed,
      false,
      { ...TRUCK_DYN, v0: 'cap' },
    ),
  );
  const e = entry.end();
  const axle = { x: e.x - L * Math.sin(e.trailer), z: e.z - L * Math.cos(e.trailer) };
  // 后退方向 = 挂车车头的反方向；先直退 2 米，再沿半径 10 米的圆弧转到垂直于后墙，最后直退靠台
  // （12 米的挂车沿 10 米半径倒车，铰接角约 50°）
  const back = new ReverseRig(
    new TimedPath(
      roundCorners(
        [
          axle,
          { x: axle.x - 2 * Math.sin(e.trailer), z: axle.z - 2 * Math.cos(e.trailer) },
          { x: doorX, z: axle.z },
          { x: doorX, z: wallZ + 0.6 + (SEMI.kingpinToRear - L) },
        ],
        10,
      ),
      () => 1.4,
      true,
      { accel: 0.5, decel: 0.8, lat: 0.8, wheelbase: 4 },
    ),
  );
  const parked = back.end();
  const leave = new ForwardRig(
    new TimedPath(
      roundCorners(
        [
          { x: parked.x, z: parked.z },
          { x: parked.x, z: zTurn },
          { x: serviceX, z: zTurn },
          { x: serviceX, z: outLane },
          { x: endX, z: outLane },
        ],
        9,
      ),
      speed,
      false,
      { ...TRUCK_DYN, v1: 'cap' },
    ),
    parked.trailer,
  );
  return { entry, back, leave, parked };
}
