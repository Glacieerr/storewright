import { createRng, type Rng } from '@storewright/domain';
import { signalLight, type LaneDef, type SignalGroup, type SiteLayout } from './site';
import { PedestrianSim } from './pedestrians';
import { VEHICLE_LENGTH, carColor, trafficType, type VehicleType } from './vehicleTypes';

/**
 * 周边道路的背景车流：每条车道上的车按智能驾驶员模型（IDM）跟车，
 * 遇红灯在停止线前停车，黄灯时来不及停的直接通过。
 * 车流到达率随拥堵程度上升；到达率超过路口通行能力时，排队会越来越长——这就是画面里的堵车。
 * 多车道路上会变道：要转弯的车提前并到对应车道，前车太慢时借道超车，路空了再回到外侧车道。
 * 主路左转走保护箭头相位；行人在人行横道上时，转弯和直行车辆都在横道前停下让行。
 */

export interface TrafficCar {
  id: number;
  d: number;
  v: number;
  type: VehicleType;
  color: string;
  len: number;
  braking: boolean;
  /** 计划在下一个路口转弯（site.turns 的下标） */
  turn?: number;
  /** 变道中：相对当前车道中线的横向偏移（米，沿车道右侧方向），逐渐回到 0 */
  shift: number;
  /** 变道冷却（秒） */
  lcCool: number;
}

/** 正在路口转弯的车：沿弧线行驶，转完后并入目标车道 */
export interface TurningCar {
  car: TrafficCar;
  turn: number;
  s: number;
}

/** 外部障碍（进出停车场的车辆）：所在车道和位置 */
export interface Obstacle {
  lane: number;
  d: number;
  len: number;
  /** 沿车道方向的速度（横穿或转弯时为 0） */
  v: number;
}

/** 最小车距（米）、期望车头时距（秒）、最大加速度与舒适减速度（m/s²） */
const S0 = 2.2;
const HEADWAY = 1.3;
const A_MAX = 1.6;
const B_COMF = 2.4;

/** 变道横移速度（米/秒）与车道宽度 */
const SHIFT_SPEED = 1.4;
const LANE_W = 3.4;

export class TrafficSim {
  readonly lanes: TrafficCar[][];
  readonly turning: TurningCar[] = [];
  /** 每帧由画面层更新：进出停车场、正在过路口的车辆，背景车流会让行 */
  obstacles: Obstacle[] = [];
  /** 路边行人（与车流共用时钟和信号灯） */
  readonly peds: PedestrianSim;
  /** 人流强度（0…1），由画面层按昼夜设置 */
  pedBusy = 1;
  time = 0;
  /** 本次运行中的变道次数（统计用） */
  laneChanges = 0;
  private pedObstacles: Obstacle[] = [];
  private readonly rng: Rng;
  private seq = 0;
  /** 同向相邻车道：外侧（靠右）与内侧 */
  private readonly adj: Array<{ outer?: number; inner?: number; group: string }>;
  private lcTimer = 0;

  constructor(
    readonly site: SiteLayout,
    seed: number,
  ) {
    this.rng = createRng(seed * 104729 + 17);
    this.lanes = site.lanes.map(() => []);
    this.peds = new PedestrianSim(site, seed);
    // 按方向（和支路所在路口）分组，组内按车道右侧方向的位置排序：越靠右越外侧
    const key = (l: LaneDef) => (l.kind === 'main' ? `m${Math.sign(l.dir.x)}` : `s${l.stops[0]?.signal ?? 0}${Math.sign(l.dir.z)}`);
    const lateral = (l: LaneDef) => l.pts[0].x * -l.dir.z + l.pts[0].z * l.dir.x;
    this.adj = site.lanes.map((l) => ({ group: key(l) }));
    const groups = new Map<string, number[]>();
    site.lanes.forEach((l, i) => groups.set(key(l), [...(groups.get(key(l)) ?? []), i]));
    for (const ids of groups.values()) {
      ids.sort((a, b) => lateral(site.lanes[b] as LaneDef) - lateral(site.lanes[a] as LaneDef));
      ids.forEach((li, k) => {
        const a = this.adj[li] as { outer?: number; inner?: number };
        if (k > 0) a.outer = ids[k - 1];
        if (k < ids.length - 1) a.inner = ids[k + 1];
      });
    }
  }

  /** 先空跑一段时间，让道路上一开始就有车 */
  warmUp(seconds: number, congestion: number): void {
    for (let t = 0; t < seconds; t += 0.25) this.step(0.25, congestion);
  }

  /** congestion = 拥堵指数 × 强度（0…2） */
  step(dt: number, congestion: number): void {
    if (dt <= 0) return;
    this.time += dt;
    this.peds.step(dt, this.time, this.pedBusy);
    this.pedObstacles = this.peds.obstacles();
    const c = Math.max(0, congestion);
    this.site.lanes.forEach((lane, li) => {
      const list = this.lanes[li] as TrafficCar[];
      const vMax = lane.speed * (1 - 0.3 * Math.min(1, c));
      for (let k = 0; k < list.length; k++) this.drive(li, lane, list, k, vMax, dt);
      while (list.length && (list[0] as TrafficCar).d - (list[0] as TrafficCar).len / 2 > lane.len) list.shift();
      // 到达转弯点的车离开本车道，进入转弯弧线；没能并到转弯车道的车放弃转弯直行
      for (let k = 0; k < list.length; k++) {
        const car = list[k] as TrafficCar;
        if (car.turn === undefined) continue;
        const turn = this.site.turns[car.turn];
        if (!turn || car.d + car.len / 2 < turn.atD) continue;
        if (turn.from !== li) {
          car.turn = undefined;
          continue;
        }
        list.splice(k--, 1);
        car.shift = 0;
        this.turning.push({ car, turn: car.turn, s: 0 });
      }
      const rate = lane.rate * (0.12 + c);
      if (this.rng.next() < 1 - Math.exp(-rate * dt)) {
        const last = list[list.length - 1];
        const type = trafficType(this.rng.next(), lane.kind === 'main' ? 0.06 : 0.02);
        const len = VEHICLE_LENGTH[type];
        if (!last || last.d - last.len / 2 > len + S0 + 2) {
          // 是否在某个路口转弯（按每个转弯的比例抽取）；转弯车道可以是同方向的另一条车道，路上再变道过去
          let turn: number | undefined;
          const group = (this.adj[li] as { group: string }).group;
          this.site.turns.forEach((t, ti) => {
            if (turn === undefined && (this.adj[t.from] as { group: string } | undefined)?.group === group && t.atD > len + 40 && this.rng.chance(t.share)) turn = ti;
          });
          list.push({ id: ++this.seq, d: len / 2, v: last ? Math.min(vMax, last.v) : vMax * 0.85, type, color: carColor(this.rng.next()), len, braking: false, turn, shift: 0, lcCool: 2 });
        }
      }
    });
    // 变道（每 0.25 秒判断一次）
    this.lcTimer += dt;
    if (this.lcTimer >= 0.25) {
      this.changeLanes(this.lcTimer);
      this.lcTimer = 0;
    }
    for (const list of this.lanes) {
      for (const car of list) {
        if (car.shift !== 0) car.shift = Math.sign(car.shift) * Math.max(0, Math.abs(car.shift) - SHIFT_SPEED * dt);
        car.lcCool = Math.max(0, car.lcCool - dt);
      }
    }
    // 转弯中的车：放慢到 5.5 m/s 沿弧线行驶，转完并入目标车道（按位置插入，后车用跟车模型减速）；
    // 目标车道的人行横道上有人时，在弧线末端前停下让行
    for (let k = 0; k < this.turning.length; k++) {
      const tc = this.turning[k] as TurningCar;
      const turn = this.site.turns[tc.turn];
      if (!turn) {
        this.turning.splice(k--, 1);
        continue;
      }
      // 弧线末端前：横道上有人，或目标车道并入点被占着，都要等
      const near = tc.s > turn.len - 5;
      const blocked =
        near &&
        ([...this.pedObstacles, ...this.obstacles].some((o) => o.lane === turn.to && o.d + o.len / 2 > turn.toD - 3 && o.d - o.len / 2 < turn.toD + 6) ||
          (this.lanes[turn.to] ?? []).some((c) => c.d - c.len / 2 < turn.toD + tc.car.len + S0 && c.d + c.len / 2 > turn.toD - 1));
      if (blocked) {
        tc.car.v = 0;
        tc.car.braking = true;
        continue;
      }
      tc.car.braking = false;
      tc.car.v = Math.max(2, Math.min(5.5, tc.car.v - 3 * dt));
      tc.s += tc.car.v * dt;
      if (tc.s >= turn.len) {
        this.turning.splice(k--, 1);
        const list = this.lanes[turn.to] as TrafficCar[];
        tc.car.d = turn.toD + tc.car.len / 2;
        tc.car.turn = undefined;
        let i = 0;
        while (i < list.length && (list[i] as TrafficCar).d > tc.car.d) i++;
        list.splice(i, 0, tc.car);
      }
    }
  }

  /** 转弯中的车辆位置与朝向 */
  turningPose(tc: TurningCar, out: { x: number; z: number; heading: number }): void {
    const turn = this.site.turns[tc.turn];
    if (!turn) return;
    let rest = tc.s;
    for (let i = 1; i < turn.pts.length; i++) {
      const a = turn.pts[i - 1] as { x: number; z: number };
      const b = turn.pts[i] as { x: number; z: number };
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      if (rest <= seg || i === turn.pts.length - 1) {
        const k = seg > 0 ? Math.min(1, rest / seg) : 1;
        out.x = a.x + (b.x - a.x) * k;
        out.z = a.z + (b.z - a.z) * k;
        out.heading = Math.atan2(b.x - a.x, b.z - a.z);
        return;
      }
      rest -= seg;
    }
  }

  private drive(li: number, lane: LaneDef, list: TrafficCar[], k: number, laneMax: number, dt: number): void {
    const car = list[k] as TrafficCar;
    const front = car.d + car.len / 2;
    // 施工路段限速（在进入前 30 米开始减速）
    let vMax = laneMax;
    for (const z of lane.zones ?? []) if (front > z.d0 - 30 && car.d < z.d1) vMax = Math.min(vMax, z.vmax);
    let gap = Number.POSITIVE_INFINITY;
    let vLead = vMax;
    const lead = list[k - 1];
    if (lead) {
      gap = lead.d - lead.len / 2 - front;
      vLead = lead.v;
    }
    // 进出停车场的车辆、人行横道上的行人：当作停在路上的障碍物让行
    for (const o of this.obstacles.concat(this.pedObstacles)) {
      if (o.lane !== li) continue;
      const g = o.d - o.len / 2 - front;
      if (g > -car.len && g < gap) {
        gap = Math.max(0.05, g);
        vLead = o.v;
      }
    }
    // 只看最近的一条还没越过的停止线；在这个路口左转的车看左转箭头
    for (const st of lane.stops) {
      const dist = st.d - front;
      if (dist < -0.5) continue;
      const signal = this.site.signals[st.signal];
      if (!signal) break;
      const turn = car.turn !== undefined ? this.site.turns[car.turn] : undefined;
      const leftHere = turn && turn.kind === 'left' && turn.signal === st.signal && turn.from === li;
      const group: SignalGroup = leftHere ? 2 : st.group;
      let light = signalLight(signal, this.time, group);
      // 左转：箭头之外，主路绿灯时对向没有来车也可以转（保护 + 许可式左转）
      if (leftHere && light === 'R' && signalLight(signal, this.time, 0) === 'G' && this.opposingClear(li, st.signal)) light = 'G';
      const canStop = dist > (car.v * car.v) / (2 * B_COMF);
      if ((light === 'R' || (light === 'Y' && canStop)) && dist < gap) {
        gap = Math.max(0.05, dist);
        vLead = 0;
      }
      break;
    }
    const s = Math.max(0.05, gap);
    const sStar = Math.max(0, S0 + car.v * HEADWAY + (car.v * (car.v - vLead)) / (2 * Math.sqrt(A_MAX * B_COMF)));
    const interaction = Number.isFinite(gap) ? (sStar / s) ** 2 : 0;
    const a = Math.max(-9, A_MAX * (1 - (car.v / vMax) ** 4 - interaction));
    car.braking = a < -0.6 || car.v < 0.3;
    car.v = Math.max(0, car.v + a * dt);
    car.d += car.v * dt;
  }

  /** 对向主路车道在这个路口前 45 米内（含路口内）没有行驶中的车 */
  private opposingClear(li: number, signal: number): boolean {
    const lane = this.site.lanes[li] as LaneDef;
    for (let oi = 0; oi < this.site.lanes.length; oi++) {
      const o = this.site.lanes[oi] as LaneDef;
      if (o.kind !== 'main' || Math.sign(o.dir.x) === Math.sign(lane.dir.x)) continue;
      const st = o.stops.find((x) => x.signal === signal);
      if (!st) continue;
      for (const c of this.lanes[oi] as TrafficCar[]) {
        const front = c.d + c.len / 2;
        if (front > st.d - 45 && c.d - c.len / 2 < st.d + 22 && (c.v > 1 || front > st.d)) return false;
      }
    }
    return true;
  }

  /**
   * 变道：先处理必须的（要转弯的车并到转弯车道），再处理自愿的（前车慢就借道，空了回外侧）。
   * 目标车道上前后都要有足够的空当：前车距离 ≥ 最小车距 + 0.5 秒车程，后车不需要急刹。
   */
  private changeLanes(dt: number): void {
    void dt;
    for (let li = 0; li < this.lanes.length; li++) {
      const list = this.lanes[li] as TrafficCar[];
      const lane = this.site.lanes[li] as LaneDef;
      const adj = this.adj[li] as { outer?: number; inner?: number };
      if (adj.outer === undefined && adj.inner === undefined) continue;
      for (let k = 0; k < list.length; k++) {
        const car = list[k] as TrafficCar;
        if (car.lcCool > 0 || car.shift !== 0) continue;
        // 路口附近（停止线前 10 米到路口另一侧）不变道
        if (lane.stops.some((st) => car.d > st.d - 10 && car.d < st.d + 16)) continue;
        let target: number | undefined;
        let mandatory = false;
        const turn = car.turn !== undefined ? this.site.turns[car.turn] : undefined;
        if (turn && turn.from !== li) {
          // 转弯车道在哪一侧
          const lat = (l: LaneDef) => l.pts[0].x * -l.dir.z + l.pts[0].z * l.dir.x;
          target = lat(this.site.lanes[turn.from] as LaneDef) > lat(lane) ? adj.outer : adj.inner;
          mandatory = true;
        } else if (!turn) {
          const lead = list[k - 1];
          const gap = lead ? lead.d - lead.len / 2 - (car.d + car.len / 2) : Infinity;
          const want = lane.speed * 0.9;
          if (lead && gap < 35 && lead.v < want - 2.5 && car.v < want - 1 && adj.inner !== undefined) target = adj.inner;
          else if (adj.outer !== undefined && this.rng.chance(0.15)) target = adj.outer;
        } else continue;
        if (target === undefined) continue;
        const dest = this.lanes[target] as TrafficCar[];
        // 目标车道中按位置找前后车
        let i = 0;
        while (i < dest.length && (dest[i] as TrafficCar).d > car.d) i++;
        const ahead = dest[i - 1];
        const behind = dest[i];
        const frontGap = ahead ? ahead.d - ahead.len / 2 - (car.d + car.len / 2) : Infinity;
        const backGap = behind ? car.d - car.len / 2 - (behind.d + behind.len / 2) : Infinity;
        const needFront = S0 + car.v * (mandatory ? 0.3 : 0.6);
        const needBack = S0 + (behind ? behind.v * (mandatory ? 0.5 : 0.9) : 0);
        if (frontGap < needFront || backGap < needBack) continue;
        // 自愿变道还要真的更快：目标车道的前车比当前前车远
        if (!mandatory && target === adj.inner) {
          const lead = list[k - 1];
          const curGap = lead ? lead.d - lead.len / 2 - (car.d + car.len / 2) : Infinity;
          if (frontGap < curGap + 12) continue;
        }
        if (!mandatory && target === adj.outer && frontGap < 60) continue;
        list.splice(k--, 1);
        dest.splice(i, 0, car);
        const fromLat = lane.pts[0].x * -lane.dir.z + lane.pts[0].z * lane.dir.x;
        const toLane = this.site.lanes[target] as LaneDef;
        const toLat = toLane.pts[0].x * -toLane.dir.z + toLane.pts[0].z * toLane.dir.x;
        car.shift = Math.max(-LANE_W, Math.min(LANE_W, fromLat - toLat));
        car.lcCool = mandatory ? 1.5 : 6;
        this.laneChanges++;
      }
    }
  }

  /** 车辆世界坐标与朝向（变道中带横向偏移和一点偏转） */
  pose(laneIndex: number, car: TrafficCar, out: { x: number; z: number; heading: number }): void {
    const lane = this.site.lanes[laneIndex] as LaneDef;
    const rx = -lane.dir.z;
    const rz = lane.dir.x;
    out.x = lane.pts[0].x + lane.dir.x * car.d + rx * car.shift;
    out.z = lane.pts[0].z + lane.dir.z * car.d + rz * car.shift;
    // 朝新车道中线偏一点：偏移在右侧时车头朝左
    const yaw = car.shift === 0 ? 0 : Math.sign(car.shift) * Math.min(0.22, Math.abs(car.shift) * 0.1);
    out.heading = Math.atan2(lane.dir.x, lane.dir.z) + yaw;
  }

  /** 当前车流统计：车辆数、平均速度（m/s）、停车排队的车辆数 */
  stats(): { cars: number; avgSpeed: number; queued: number } {
    let n = 0;
    let v = 0;
    let q = 0;
    for (const c of [...this.lanes.flat(), ...this.turning.map((t) => t.car)]) {
      n++;
      v += c.v;
      if (c.v < 0.5) q++;
    }
    return { cars: n, avgSpeed: n ? v / n : 0, queued: q };
  }
}

let shared: { site: SiteLayout; sim: TrafficSim } | undefined;

/** 同一份周边环境只保留一个车流实例（场景里的信号灯和车辆共用它的时钟） */
export function trafficFor(site: SiteLayout, seed: number, congestion: number): TrafficSim {
  if (shared?.site !== site) {
    const sim = new TrafficSim(site, seed);
    sim.warmUp(150, congestion);
    shared = { site, sim };
  }
  return shared.sim;
}

/** 当前的车流实例（调试用） */
export function currentTraffic(): TrafficSim | undefined {
  return shared?.sim;
}
