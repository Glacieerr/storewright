import type { Rng } from '../core/rng';
import { H, type Sim } from '../core/sim';
import type { Role } from '../world/config';
import type { Pt } from '../world/layout';
import type { Router } from '../world/path';
import type { AgentKind, Trace } from './trace';

/**
 * 员工和机器人：都是「执行步骤」的个体。一个任务就是一串步骤（走过去、干活、等顾客、触发一件事），
 * 执行器按顺序排进事件队列，同时记下动画轨迹和工时。
 */
export type Step =
  | { kind: 'walk'; to: Pt; speed?: number; outdoors?: boolean; act?: string }
  /** 干活：时长可以是函数，开始这一步时才算（例如上架件数要等送箱到了才知道） */
  | { kind: 'work'; sec: number | (() => number); act: string; at?: Pt }
  /** 等到某个时刻（例如顾客到达）；等待时间不算有效工时 */
  | { kind: 'until'; t: number; act: string }
  /** 暂停，直到 resume 被调用（例如等补货机器人送箱到） */
  | { kind: 'wait'; start: (resume: () => void) => void; act: string }
  | { kind: 'call'; fn: () => void };

export interface Member {
  id: number;
  label: string;
  /** 上岗的位置 */
  home: Pt;
  pos: Pt;
  busy: boolean;
  /** 员工：是否在岗；机器人：是否可用（没坏、没在充电） */
  active: boolean;
  /** 下班或进维修：做完手上的任务再离开 */
  leaving: boolean;
  agent: number;
  /** 有效工时、在岗时长（秒） */
  productive: number;
  onDutySince: number;
  onDutyTotal: number;
  busySince: number;
}

export interface Task {
  priority: number;
  label: string;
  steps: (m: Member) => Step[];
  onDone?: (m: Member) => void;
  /** 只能交给这些成员（例如固定在某个站台的拣货员） */
  only?: (m: Member) => boolean;
  seq?: number;
}

export interface PoolOptions {
  kind: AgentKind;
  name: string;
  home: Pt;
  /** 每个成员各自的上岗位置（按编号轮流取，例如站台拣货员各守一个站台）；不给时都用 home */
  homes?: readonly Pt[];
  speed: number;
  /** 员工：每小时在岗人数（24 个值）；机器人：数量固定 */
  schedule?: readonly number[];
  count?: number;
  /** 机器人才有：无故障时间（小时）和修复时间（分钟） */
  reliability?: { mtbfHours: number; mttrMin: number };
  rng: Rng;
  /** 设备（自助结账机、出口通道）：不画动画 */
  silent?: boolean;
}

export class Pool {
  members: Member[] = [];
  private queue: Task[] = [];
  private seq = 0;
  /** 故障次数、累计停机（秒） */
  failures = 0;
  downtime = 0;
  /** 每小时在岗 / 忙碌人数的累计（秒），用来画曲线 */
  readonly busyByHour = new Float64Array(24);
  readonly onDutyByHour = new Float64Array(24);
  private lastSample = 0;

  constructor(
    readonly sim: Sim,
    readonly router: Router,
    readonly trace: Trace,
    readonly opts: PoolOptions,
  ) {
    const n = opts.schedule ? Math.max(0, ...opts.schedule) : (opts.count ?? 0);
    for (let i = 0; i < n; i++) {
      const home = opts.homes?.length ? (opts.homes[i % opts.homes.length] as Pt) : opts.home;
      this.members.push({
        id: i,
        label: `${opts.name} ${i + 1}`,
        home,
        pos: { ...home },
        busy: false,
        active: !opts.schedule,
        leaving: false,
        agent: opts.silent ? -1 : trace.add(opts.kind, `${opts.name} ${i + 1}`, home),
        productive: 0,
        onDutySince: 0,
        onDutyTotal: 0,
        busySince: 0,
      });
    }
    if (opts.schedule) {
      for (let h = 0; h < 24; h++) sim.at(h * H, () => this.applyShift(h));
    }
    sim.at(0, () => this.sample());
  }

  get size(): number {
    return this.members.length;
  }

  get activeCount(): number {
    return this.members.filter((m) => m.active && !m.leaving).length;
  }

  get idleCount(): number {
    return this.members.filter((m) => m.active && !m.leaving && !m.busy).length;
  }

  get queued(): number {
    return this.queue.length;
  }

  submit(task: Task): void {
    task.seq = this.seq++;
    // 按优先级（小的先做）再按提交顺序
    let i = this.queue.length;
    while (i > 0 && compare(this.queue[i - 1] as Task, task) > 0) i--;
    this.queue.splice(i, 0, task);
    this.dispatch();
  }

  /** 每小时按排班调整在岗人数：多了的人做完手上的事再下班 */
  private applyShift(h: number): void {
    const want = this.opts.schedule?.[h] ?? 0;
    const t = this.sim.now;
    let on = this.members.filter((m) => m.active && !m.leaving).length;
    for (const m of this.members) {
      if (on >= want) break;
      if (m.leaving) {
        m.leaving = false;
        on++;
      } else if (!m.active) {
        m.active = true;
        m.onDutySince = t;
        m.pos = { ...m.home };
        this.trace.shift(m.agent, t, true);
        on++;
      }
    }
    for (let i = this.members.length - 1; i >= 0 && on > want; i--) {
      const m = this.members[i] as Member;
      if (!m.active || m.leaving) continue;
      if (m.busy) m.leaving = true;
      else this.offDuty(m);
      on--;
    }
    this.dispatch();
  }

  private offDuty(m: Member): void {
    m.active = false;
    m.leaving = false;
    m.onDutyTotal += this.sim.now - m.onDutySince;
    this.trace.shift(m.agent, this.sim.now, false);
  }

  private sample(): void {
    // 每 5 分钟采样一次在岗和忙碌人数（画每小时曲线）
    const t = this.sim.now;
    const h = Math.min(23, Math.floor(t / H));
    const dt = 300;
    this.onDutyByHour[h] = (this.onDutyByHour[h] as number) + this.activeCount * dt;
    this.busyByHour[h] = (this.busyByHour[h] as number) + this.members.filter((m) => m.busy).length * dt;
    this.lastSample = t;
    if (t + dt < 24 * H) this.sim.after(dt, () => this.sample());
  }

  dispatch(): void {
    if (!this.queue.length) return;
    for (const m of this.members) {
      if (!m.active || m.leaving || m.busy) continue;
      const idx = this.queue.findIndex((task) => !task.only || task.only(m));
      if (idx < 0) continue;
      const task = this.queue.splice(idx, 1)[0] as Task;
      this.run(m, task);
      if (!this.queue.length) return;
    }
  }

  private run(m: Member, task: Task): void {
    m.busy = true;
    m.busySince = this.sim.now;
    const steps = task.steps(m);
    let i = 0;
    const next = (): void => {
      if (i >= steps.length) {
        m.busy = false;
        task.onDone?.(m);
        this.afterTask(m);
        return;
      }
      const step = steps[i++] as Step;
      const t0 = this.sim.now;
      switch (step.kind) {
        case 'walk': {
          const meters = this.router.distance(m.pos, step.to, step.outdoors ?? false);
          const dt = meters / (step.speed ?? this.opts.speed);
          if (this.trace.enabled && dt > 0) this.trace.move(m.agent, t0, t0 + dt, this.router.path(m.pos, step.to, step.outdoors ?? false), step.act);
          m.pos = { ...step.to };
          m.productive += dt;
          this.sim.after(dt, next);
          break;
        }
        case 'work': {
          if (step.at) m.pos = { ...step.at };
          const sec = Math.max(0, typeof step.sec === 'function' ? step.sec() : step.sec);
          this.trace.dwell(m.agent, t0, t0 + sec, m.pos, step.act);
          m.productive += sec;
          this.sim.after(sec, next);
          break;
        }
        case 'until': {
          const dt = Math.max(0, step.t - t0);
          this.trace.dwell(m.agent, t0, t0 + dt, m.pos, step.act);
          this.sim.after(dt, next);
          break;
        }
        case 'wait': {
          let resumed = false;
          step.start(() => {
            if (resumed) return;
            resumed = true;
            this.trace.dwell(m.agent, t0, this.sim.now, m.pos, step.act);
            next();
          });
          break;
        }
        case 'call': {
          step.fn();
          next();
          break;
        }
      }
    };
    next();
  }

  /** 做完一个任务：机器人按忙碌时长算故障概率；员工如果该下班了就下班 */
  private afterTask(m: Member): void {
    const rel = this.opts.reliability;
    if (rel) {
      const busy = this.sim.now - m.busySince;
      if (this.opts.rng.chance(1 - Math.exp(-busy / (rel.mtbfHours * H)))) {
        this.failures++;
        const down = this.opts.rng.logNormal(rel.mttrMin * 60, 0.5);
        this.downtime += down;
        m.active = false;
        this.trace.event(this.sim.now, 'robot', `${m.label} 故障，预计 ${Math.round(down / 60)} 分钟修好`);
        this.sim.after(down, () => {
          m.active = true;
          this.dispatch();
        });
        this.dispatch();
        return;
      }
    }
    if (m.leaving) this.offDuty(m);
    this.dispatch();
  }

  /** 收尾：把还在岗的时长算上 */
  close(t: number): void {
    for (const m of this.members) {
      if (this.opts.schedule && m.active) {
        m.onDutyTotal += t - m.onDutySince;
        m.onDutySince = t;
      }
    }
  }

  get productiveSec(): number {
    return this.members.reduce((s, m) => s + m.productive, 0);
  }

  get onDutySec(): number {
    return this.members.reduce((s, m) => s + m.onDutyTotal, 0);
  }
}

function compare(a: Task, b: Task): number {
  return a.priority - b.priority || (a.seq ?? 0) - (b.seq ?? 0);
}

export type Crew = Record<Role, Pool>;
