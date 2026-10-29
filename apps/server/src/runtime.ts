import { applyEvent, emptyState, type AnyOpsEvent, type CommandEnvelope, type OpsState, type Rejection, type StoreStatic } from '@storewright/ops';
import { decide, stamp, type OpsContext } from '@storewright/ops/server';
import { ConflictError, type EventLog } from './storage';

export type SubmitResult = { ok: true; events: AnyOpsEvent[]; duplicate?: boolean } | { ok: false; reject: Rejection };

/** 推送给订阅者的消息 */
export type HubMessage = { t: 'events'; events: AnyOpsEvent[] } | { t: 'reset' };

/**
 * 一个门店的运行时：内存中的当前状态 + 串行的命令队列 + 订阅者。
 *
 * 命令按到达顺序逐条处理：decide → 写入事件存储 → 应用到内存状态 → 推送。写入失败时状态不变。
 * 同一进程内串行处理，避免无谓的并发冲突；多个进程同时写同一门店时，靠事件表主键检测冲突后重读重试。
 */
export class StoreRuntime {
  state: OpsState = emptyState();
  /** 最近的事件，用于断线重连时快速补发 */
  private recent: AnyOpsEvent[] = [];
  /** 事件记录里第一条事件的时间（复盘只看系统在运行的时段） */
  firstEventAt: number | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** 门店里的服务（AI、自动运营、客流仿真）：每条命令的事件立即收到 */
  private readonly listeners = new Set<(m: HubMessage) => void>();
  /** 设备连接：推送合批 */
  private readonly devices = new Set<(m: HubMessage) => void>();
  /** 推送合批（决策记录 0014，只用于设备连接）：空闲时立即推送；忙的时候 batchMs 内的事件合成一条消息，设备多时消息数不随命令数增长 */
  private pending: AnyOpsEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlush = 0;

  constructor(
    readonly id: string,
    readonly ctx: OpsContext,
    readonly statics: StoreStatic,
    private readonly store: EventLog,
    private readonly recentLimit = 5000,
    private readonly batchMs = 15,
  ) {}

  async init(): Promise<void> {
    const events = await this.store.load(this.id);
    for (const e of events) applyEvent(this.state, e, this.statics);
    this.remember(events);
  }

  submit(env: CommandEnvelope, commandId?: string): Promise<SubmitResult> {
    const run = this.queue.then(() => this.handle(env, commandId));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** 订阅事件：门店里的服务立即收到；device = true 是设备连接，推送合批 */
  subscribe(fn: (m: HubMessage) => void, opts: { device?: boolean } = {}): () => void {
    const set = opts.device ? this.devices : this.listeners;
    set.add(fn);
    return () => set.delete(fn);
  }

  get subscribers(): number {
    return this.listeners.size + this.devices.size;
  }

  /** 内存里最近的事件（最多 recentLimit 条；问数里查某张订单的经过用） */
  recentEvents(): readonly AnyOpsEvent[] {
    return this.recent;
  }

  /** seq 之后的事件；太旧（不在内存中）时返回 undefined，调用方改发快照 */
  eventsAfter(seq: number): AnyOpsEvent[] | undefined {
    if (seq >= this.state.seq) return [];
    const first = this.recent[0];
    if (!first || first.seq > seq + 1) return undefined;
    return this.recent.slice(seq + 1 - first.seq);
  }

  async reset(): Promise<void> {
    await this.queue;
    await this.store.reset(this.id);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending = [];
    this.state = emptyState();
    this.recent = [];
    this.firstEventAt = undefined;
    for (const l of [...this.listeners, ...this.devices]) l({ t: 'reset' });
  }

  private async handle(env: CommandEnvelope, commandId?: string): Promise<SubmitResult> {
    if (commandId) {
      const prev = (await this.store.commandResult(this.id, commandId)) as SubmitResult | undefined;
      if (prev && prev.ok) return { ...prev, duplicate: true };
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const d = decide(this.state, env, this.ctx);
      if (!d.ok) return { ok: false, reject: d.reject };
      if (!d.events.length) return { ok: true, events: [] };
      const events = stamp(this.state, d.events, env);
      try {
        await this.store.append(this.id, events, commandId ? { id: commandId, result: { ok: true, events }, at: env.at } : undefined);
      } catch (e) {
        if (e instanceof ConflictError) {
          await this.catchUp();
          continue;
        }
        throw e;
      }
      for (const ev of events) applyEvent(this.state, ev, this.statics);
      this.remember(events);
      this.emit(events);
      return { ok: true, events };
    }
    throw new Error('event store conflict did not resolve');
  }

  /** 别的进程写入了新事件：读取并应用 */
  private async catchUp(): Promise<void> {
    const more = await this.store.load(this.id, this.state.seq);
    for (const e of more) applyEvent(this.state, e, this.statics);
    this.remember(more);
    if (more.length) this.emit(more);
  }

  private remember(events: readonly AnyOpsEvent[]): void {
    if (!events.length) return;
    this.firstEventAt ??= events[0]?.at;
    this.recent.push(...events);
    if (this.recent.length > this.recentLimit) this.recent.splice(0, this.recent.length - this.recentLimit);
  }

  private emit(events: AnyOpsEvent[]): void {
    const now: HubMessage = { t: 'events', events };
    for (const l of this.listeners) l(now);
    if (this.batchMs <= 0) return this.deliver(events);
    this.pending.push(...events);
    // 合批有上限：一直没有机会触发定时器时（例如连续的同步提交）也不会攒成一条巨大的消息
    if (this.pending.length >= 256) return this.flush();
    if (this.flushTimer) return;
    const wait = this.lastFlush + this.batchMs - Date.now();
    if (wait <= 0) this.flush();
    else this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  /** 把合批中的事件立即推送出去（测试和关闭时用） */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.lastFlush = Date.now();
    const events = this.pending;
    this.pending = [];
    if (events.length) this.deliver(events);
  }

  private deliver(events: AnyOpsEvent[]): void {
    const m: HubMessage = { t: 'events', events };
    for (const l of this.devices) l(m);
  }
}
