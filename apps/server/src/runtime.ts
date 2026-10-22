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
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(m: HubMessage) => void>();

  constructor(
    readonly id: string,
    readonly ctx: OpsContext,
    readonly statics: StoreStatic,
    private readonly store: EventLog,
    private readonly recentLimit = 5000,
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

  subscribe(fn: (m: HubMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get subscribers(): number {
    return this.listeners.size;
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
    this.state = emptyState();
    this.recent = [];
    for (const l of this.listeners) l({ t: 'reset' });
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
    this.recent.push(...events);
    if (this.recent.length > this.recentLimit) this.recent.splice(0, this.recent.length - this.recentLimit);
  }

  private emit(events: AnyOpsEvent[]): void {
    const m: HubMessage = { t: 'events', events };
    for (const l of this.listeners) l(m);
  }
}
