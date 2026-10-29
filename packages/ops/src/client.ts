import { applyEvent } from './apply';
import type { OpsCommand, Rejection } from './commands';
import type { AnyOpsEvent } from './events';
import { emptyState, type OpsState, type StoreStatic } from './types';

/**
 * 实时客户端（员工端和模拟器 Live 模式共用）：快照 + 流序号 + 断线重同步（技术栈 3.3 节）。
 *
 * - 连接 WebSocket 时带上最后收到的序号，服务端补发之后的事件，差得太多时发快照；
 * - 收到的事件序号不连续时请求补发；重复的事件按序号丢弃；
 * - 命令走 REST，返回的事件立即应用（本机马上看到结果），推送里再收到同样的事件时丢弃；
 * - 网络不通时命令进入本地发件箱，恢复连接后按顺序提交，由服务端校验；被拒绝的命令通过回调告诉界面。
 */

export type LinkStatus = 'connecting' | 'live' | 'offline';

export type CommandResult =
  | { ok: true; events: AnyOpsEvent[]; queued?: false }
  | { ok: true; events: []; queued: true }
  | { ok: false; reject: Rejection };

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LiveClientOptions {
  /** 例如 http://192.168.1.20:8787；空字符串表示同源 */
  baseUrl: string;
  storeId: string;
  token: string;
  storage?: KeyValueStorage;
  onChange?: () => void;
  /** 发件箱里的命令在重新连接后被拒绝 */
  onRejected?: (cmd: OpsCommand, reject: Rejection) => void;
  /** 令牌无效（服务端拒绝连接）：不再重试，界面应要求重新登录 */
  onAuthError?: () => void;
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
  pingMs?: number;
  /** 订阅数字孪生的遥测推送（模拟器、控制台；员工手机不订阅，决策记录 0016） */
  twin?: boolean;
  /** 收到一帧孪生推送（内容见 @storewright/twin 的 TwinFrame） */
  onTwin?: (frame: unknown) => void;
}

interface Queued {
  id: string;
  cmd: OpsCommand;
  at: number;
}

function randomId(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export class LiveClient {
  state: OpsState = emptyState();
  statics: StoreStatic | undefined;
  /** 本机这份静态数据的版本；连接时告诉服务端，版本相同时快照里不再带静态数据（决策记录 0014） */
  staticsHash: string | undefined;
  status: LinkStatus = 'connecting';
  /** 服务端时间 - 本机时间（毫秒） */
  offset = 0;
  /** 最近一次往返时间（毫秒） */
  rtt = 0;
  /** 每次状态变化加一，界面用它判断是否重新渲染 */
  version = 0;
  outbox: Queued[] = [];
  /** 最近一帧孪生推送（订阅了孪生时） */
  twinFrame: unknown;
  private ws: WebSocket | undefined;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pinger: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private flushing = false;
  private pingSeq = 0;
  private readonly pings = new Map<number, number>();
  private readonly WS: typeof WebSocket;
  private readonly fetcher: typeof fetch;
  private readonly outboxKey: string;
  private readonly listeners = new Set<(events: AnyOpsEvent[]) => void>();
  private readonly changeListeners = new Set<() => void>();

  constructor(private readonly o: LiveClientOptions) {
    this.WS = o.WebSocketImpl ?? globalThis.WebSocket;
    this.fetcher = o.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.outboxKey = `storewright.outbox.${o.storeId}.${o.token.slice(0, 8)}`;
    try {
      const saved = o.storage?.getItem(this.outboxKey);
      if (saved) this.outbox = JSON.parse(saved) as Queued[];
    } catch {
      this.outbox = [];
    }
    // 上次保存的门店静态数据（陈列表、库位、名单……大型店有一两兆）：版本没变就不用再下载
    try {
      const cached = o.storage?.getItem(this.staticsKey());
      if (cached) {
        const c = JSON.parse(cached) as { hash: string; statics: StoreStatic };
        this.statics = c.statics;
        this.staticsHash = c.hash;
      }
    } catch {
      // 忽略：下次连接时服务端会发完整的静态数据
    }
  }

  /** 服务端时钟的当前时间 */
  now(): number {
    return Date.now() + this.offset;
  }

  /** 订阅任何变化（状态、连接、发件箱）；可直接用于 React 的 useSyncExternalStore */
  subscribe = (fn: () => void): (() => void) => {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  };

  /** 订阅新应用的事件（例如显示提醒） */
  onEvents(fn: (events: AnyOpsEvent[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pinger) clearInterval(this.pinger);
    this.ws?.close();
    this.ws = undefined;
    this.setStatus('offline');
  }

  /** 提交命令；离线时进入发件箱 */
  async send(cmd: OpsCommand): Promise<CommandResult> {
    const q: Queued = { id: randomId(), cmd, at: Date.now() };
    if (this.status !== 'live' || this.outbox.length) {
      this.enqueue(q);
      return { ok: true, events: [], queued: true };
    }
    try {
      return await this.post(q);
    } catch {
      this.enqueue(q);
      this.setStatus('offline');
      return { ok: true, events: [], queued: true };
    }
  }

  /** 读取门店接口（带会话令牌），例如 /twin、/twin/at?t=…；失败时抛出错误 */
  async getJson<T>(path: string): Promise<T> {
    const res = await this.fetcher(this.url(path), { headers: { authorization: `Bearer ${this.o.token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private url(path: string, ws = false): string {
    const base = this.o.baseUrl || ((globalThis as { location?: { origin: string } }).location?.origin ?? '');
    const u = `${base.replace(/\/$/, '')}/api/stores/${encodeURIComponent(this.o.storeId)}${path}`;
    return ws ? u.replace(/^http/, 'ws') : u;
  }

  private async post(q: Queued): Promise<CommandResult> {
    const res = await this.fetcher(this.url('/commands'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.token}` },
      body: JSON.stringify({ id: q.id, cmd: q.cmd }),
    });
    if (res.status === 401 || res.status === 403 || res.status === 400) {
      return { ok: false, reject: { code: res.status === 400 ? 'INVALID_ORDER' : 'NOT_IN_SESSION', params: { http: res.status } } };
    }
    if (res.status >= 500) throw new Error(`server ${res.status}`);
    const body = (await res.json()) as CommandResult;
    if (body.ok && body.events.length) this.apply(body.events);
    return body;
  }

  private enqueue(q: Queued): void {
    this.outbox.push(q);
    this.saveOutbox();
    this.bump();
  }

  private saveOutbox(): void {
    try {
      this.o.storage?.setItem(this.outboxKey, JSON.stringify(this.outbox));
    } catch {
      // 本机存储不可用时发件箱只在内存中
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.outbox.length && this.status === 'live') {
        const q = this.outbox[0] as Queued;
        let r: CommandResult;
        try {
          r = await this.post(q);
        } catch {
          this.setStatus('offline');
          break;
        }
        this.outbox.shift();
        this.saveOutbox();
        if (!r.ok) this.o.onRejected?.(q.cmd, r.reject);
        this.bump();
      }
    } finally {
      this.flushing = false;
    }
  }

  private open(): void {
    if (this.closed) return;
    this.setStatus('connecting');
    const known = this.statics && this.staticsHash ? `&statics=${encodeURIComponent(this.staticsHash)}` : '';
    const url = `${this.url('/ws', true)}?after=${this.state.seq}&token=${encodeURIComponent(this.o.token)}${known}`;
    let ws: WebSocket;
    try {
      ws = new this.WS(url);
    } catch {
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => this.onMessage(String(ev.data));
    ws.onclose = (ev: { code: number }) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.pinger) clearInterval(this.pinger);
      if (ev.code === 4401) {
        this.closed = true;
        this.setStatus('offline');
        this.o.onAuthError?.();
        return;
      }
      if (!this.closed) {
        this.setStatus('offline');
        this.schedule();
      }
    };
    ws.onerror = () => {
      // onclose 会接着触发
    };
  }

  private schedule(): void {
    if (this.closed) return;
    const delay = Math.min(10_000, 500 * 2 ** this.retry);
    this.retry += 1;
    this.timer = setTimeout(() => this.open(), delay);
  }

  private onMessage(raw: string): void {
    let m: { t: string; [k: string]: unknown };
    try {
      m = JSON.parse(raw) as typeof m;
    } catch {
      return;
    }
    switch (m.t) {
      case 'hello': {
        this.retry = 0;
        const serverTime = Number(m.serverTime);
        if (Number.isFinite(serverTime)) this.offset = serverTime - Date.now();
        // 服务端被清空过（序号比本机小）：等快照
        if (Number(m.seq) < this.state.seq) this.ws?.send(JSON.stringify({ t: 'resync', after: 0 }));
        this.setStatus('live');
        this.startPing();
        if (this.o.twin) this.ws?.send(JSON.stringify({ t: 'twin', on: true }));
        void this.flush();
        break;
      }
      case 'snapshot':
        this.state = m.state as OpsState;
        // 服务端省略静态数据：本机的版本和服务端相同
        if (m.statics) {
          this.statics = m.statics as StoreStatic;
          this.staticsHash = typeof m.staticsHash === 'string' ? m.staticsHash : undefined;
          this.saveStatics();
        }
        this.bump();
        break;
      case 'events':
        this.apply(m.events as AnyOpsEvent[]);
        break;
      case 'twin':
        this.twinFrame = m;
        this.o.onTwin?.(m);
        break;
      case 'pong': {
        const sent = this.pings.get(Number(m.id));
        if (sent !== undefined) {
          this.pings.delete(Number(m.id));
          const now = Date.now();
          this.rtt = now - sent;
          this.offset = Number(m.serverTime) - (sent + this.rtt / 2);
        }
        break;
      }
    }
  }

  private startPing(): void {
    if (this.pinger) clearInterval(this.pinger);
    const ping = () => {
      if (!this.ws || this.ws.readyState !== 1) return;
      const id = ++this.pingSeq;
      this.pings.set(id, Date.now());
      this.ws.send(JSON.stringify({ t: 'ping', id }));
    };
    ping();
    this.pinger = setInterval(ping, this.o.pingMs ?? 10_000);
  }

  /** 按序号应用：重复的丢弃，不连续时请求补发 */
  private apply(events: readonly AnyOpsEvent[]): void {
    const applied: AnyOpsEvent[] = [];
    for (const e of events) {
      if (e.seq <= this.state.seq) continue;
      if (e.seq !== this.state.seq + 1) {
        this.ws?.send(JSON.stringify({ t: 'resync', after: this.state.seq }));
        break;
      }
      applyEvent(this.state, e, this.statics);
      applied.push(e);
    }
    if (!applied.length) return;
    this.bump();
    for (const l of this.listeners) l(applied);
  }

  private staticsKey(): string {
    return `storewright.statics.${this.o.storeId}`;
  }

  private saveStatics(): void {
    if (!this.staticsHash || !this.statics) return;
    try {
      this.o.storage?.setItem(this.staticsKey(), JSON.stringify({ hash: this.staticsHash, statics: this.statics }));
    } catch {
      // 本机存储满了：只是下次要重新下载
    }
  }

  private setStatus(s: LinkStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.bump();
  }

  private bump(): void {
    this.version += 1;
    this.o.onChange?.();
    for (const f of this.changeListeners) f();
  }
}
