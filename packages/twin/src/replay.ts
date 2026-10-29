import { applyEvent, emptyState, type AnyOpsEvent, type OpsState, type StoreStatic } from '@storewright/ops';

/**
 * 回放（决策记录 0016 第 4.2 节）：作业状态就是事件依次应用的结果，所以任何时刻的门店都可以精确重建。
 * 至少隔 every 条事件、并且至少隔 minGapMs 存一个检查点（高负载时不会频繁复制整份状态；超过 hardEvery 条一定存），
 * 拖动时间轴时从最近的检查点往后应用；检查点太多时隔一个删一个。
 * 事件超过 maxEvents 条时，最早的四分之一并进起点状态（之后只能回放到并入后的第一条事件），长期运行的服务内存有上限。
 * 运行中追加事件时可以传入「此刻的状态」（门店运行时已经应用过这些事件）：不再自己重复应用一遍，检查点直接复制它。
 */
export class ReplayLog {
  private events: AnyOpsEvent[] = [];
  /** 每条事件的时间，取到这条为止的最大值：命令的时间由提交方给出，排队时偶尔会比前一条早几毫秒 */
  private times: number[] = [];
  private checkpoints: Array<{ index: number; state: OpsState }> = [];
  private head: OpsState = emptyState();
  /** 追加时传入的「此刻的状态」：有了它就不维护 head */
  private current: (() => OpsState) | undefined;
  /** 保留的第一条事件之前的状态（并入的旧事件） */
  private base: OpsState = emptyState();
  private lastCheckpoint = { index: 0, at: -Infinity };

  constructor(
    private readonly statics: StoreStatic,
    private readonly every = 3000,
    private readonly maxCheckpoints = 16,
    private readonly maxEvents = 150_000,
    private readonly minGapMs = 60_000,
    private readonly hardEvery = 60_000,
  ) {}

  get size(): number {
    return this.events.length;
  }

  get firstAt(): number | undefined {
    return this.events[0]?.at;
  }

  get lastAt(): number | undefined {
    return this.events[this.events.length - 1]?.at;
  }

  /**
   * 追加事件。current：应用完这批事件之后的状态（门店运行时的状态）；传入时不再重复应用，检查点只在这批事件的末尾存。
   * 不传时（服务启动时载入历史）自己应用，可以在任意位置存检查点。
   */
  append(evs: readonly AnyOpsEvent[], current?: () => OpsState): void {
    if (current) this.current = current;
    for (const e of evs) {
      if (this.events.length && e.seq <= (this.events[this.events.length - 1] as AnyOpsEvent).seq) continue;
      this.events.push(e);
      this.times.push(Math.max(e.at, this.times[this.times.length - 1] ?? e.at));
      if (current) continue;
      applyEvent(this.head, e, this.statics);
      this.maybeCheckpoint(e.at, () => this.head);
    }
    const last = this.events[this.events.length - 1];
    if (current && last) this.maybeCheckpoint(last.at, current);
    while (this.events.length > this.maxEvents) this.trim(Math.max(1, Math.floor(this.maxEvents / 4)));
  }

  private maybeCheckpoint(at: number, state: () => OpsState): void {
    const since = this.events.length - this.lastCheckpoint.index;
    if (since < this.hardEvery && (since < this.every || at - this.lastCheckpoint.at < this.minGapMs)) return;
    this.checkpoints.push({ index: this.events.length, state: structuredClone(state()) });
    this.lastCheckpoint = { index: this.events.length, at };
    if (this.checkpoints.length > this.maxCheckpoints) this.checkpoints = this.checkpoints.filter((_, i) => i % 2 === 1);
  }

  /** 把最早的 n 条事件并进起点状态 */
  private trim(n: number): void {
    for (let i = 0; i < n; i++) applyEvent(this.base, this.events[i] as AnyOpsEvent, this.statics);
    this.events = this.events.slice(n);
    this.times = this.times.slice(n);
    this.checkpoints = this.checkpoints.filter((c) => c.index > n).map((c) => ({ index: c.index - n, state: c.state }));
    this.lastCheckpoint = { index: Math.max(0, this.lastCheckpoint.index - n), at: this.lastCheckpoint.at };
  }

  reset(): void {
    this.events = [];
    this.times = [];
    this.checkpoints = [];
    this.head = emptyState();
    this.current = undefined;
    this.base = emptyState();
    this.lastCheckpoint = { index: 0, at: -Infinity };
  }

  /** t 时刻（含）之前的事件条数 */
  private countAt(t: number): number {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.times[mid] as number) <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** t 时刻的门店状态（一份新的副本，可以随意修改） */
  stateAt(t: number): OpsState {
    const k = this.countAt(t);
    if (k === this.events.length) return structuredClone(this.current ? this.current() : this.head);
    let base: { index: number; state: OpsState } | undefined;
    for (const c of this.checkpoints) if (c.index <= k) base = c;
    const s = structuredClone(base ? base.state : this.base);
    for (let i = base?.index ?? 0; i < k; i++) applyEvent(s, this.events[i] as AnyOpsEvent, this.statics);
    return s;
  }

  /** [from, to] 之间的事件（回放时的事件流） */
  between(from: number, to: number, limit = 200): AnyOpsEvent[] {
    const a = this.countAt(from);
    const b = this.countAt(to);
    return this.events.slice(Math.max(a, b - limit), b);
  }
}
