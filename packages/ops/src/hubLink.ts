/**
 * 浏览器内演示模式的连接层：页面与门店中枢（SharedWorker / Worker，见员工端 src/demo/hubWorker.ts）之间的消息，
 * 以及基于一个消息端口的 fetch 与 WebSocket 替身。员工端和模拟器共用（模拟器经过员工端的 bridge.html 拿到端口）。
 */

export interface HubLinkRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface HubLinkResponse {
  status: number;
  body: unknown;
  type?: string;
}

export type ToHub =
  | { k: 'req'; id: number; req: HubLinkRequest }
  | { k: 'open'; sid: number; storeId: string; token: string; after: number }
  | { k: 'send'; sid: number; data: string }
  | { k: 'close'; sid: number }
  /** 把另一个 MessagePort 交给中枢（展示页、模拟器的桥接页面） */
  | { k: 'port' };

export type FromHub =
  | { k: 'res'; id: number; res: HubLinkResponse }
  | { k: 'msg'; sid: number; data: string }
  | { k: 'closed'; sid: number; code: number; reason: string }
  /** 中枢的进度（第一次建店时训练 AI 模型需要几秒）：training / ready */
  | { k: 'status'; text: string };

export const HUB_NAME = 'storewright-demo-hub';

/** 窗口之间传递端口用的消息类型 */
export const PORT_REQUEST = 'storewright-hub-port-request';
export const PORT_REPLY = 'storewright-hub-port';

export interface HubPort {
  postMessage(m: ToHub, transfer?: unknown[]): void;
  onmessage: ((ev: { data: FromHub }) => void) | null;
}

export interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface HubLink {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** 可以直接传给 LiveClient 的 WebSocketImpl */
  WebSocket: new (url: string) => SocketLike;
  onStatus(fn: (text: string) => void): () => void;
  /** 关闭这一页的所有实时连接（页面关闭时） */
  closeAll(): void;
}

export function createHubLink(getPort: () => Promise<HubPort>): HubLink {
  let ready: Promise<HubPort> | undefined;
  let nextId = 1;
  const pending = new Map<number, (r: HubLinkResponse) => void>();
  const sockets = new Map<number, LinkSocket>();
  const statusListeners = new Set<(text: string) => void>();
  const base = (): string => (globalThis as { location?: { href: string } }).location?.href ?? 'http://local/';

  const port = (): Promise<HubPort> => {
    ready ??= getPort().then((p) => {
      p.onmessage = (ev) => {
        const m = ev.data;
        if (m.k === 'res') {
          pending.get(m.id)?.(m.res);
          pending.delete(m.id);
        } else if (m.k === 'msg') sockets.get(m.sid)?.deliver(m.data);
        else if (m.k === 'closed') sockets.get(m.sid)?.remoteClose(m.code, m.reason);
        else if (m.k === 'status') for (const l of statusListeners) l(m.text);
      };
      return p;
    });
    return ready;
  };

  class LinkSocket implements SocketLike {
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    private readonly sid = nextId++;

    constructor(url: string) {
      const u = new URL(url, base());
      const storeId = decodeURIComponent(/\/api\/stores\/([^/]+)\/ws/.exec(u.pathname)?.[1] ?? '');
      sockets.set(this.sid, this);
      void port().then((p) => {
        if (this.readyState === 3) return;
        this.readyState = 1;
        this.onopen?.({});
        p.postMessage({ k: 'open', sid: this.sid, storeId, token: u.searchParams.get('token') ?? '', after: Number(u.searchParams.get('after') ?? 0) });
      });
    }

    send(data: string): void {
      if (this.readyState !== 1) return;
      void port().then((p) => p.postMessage({ k: 'send', sid: this.sid, data }));
    }

    close(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      sockets.delete(this.sid);
      void port().then((p) => p.postMessage({ k: 'close', sid: this.sid }));
      this.onclose?.({ code: 1000, reason: '' });
    }

    deliver(data: string): void {
      if (this.readyState === 1) this.onmessage?.({ data });
    }

    remoteClose(code: number, reason: string): void {
      this.readyState = 3;
      sockets.delete(this.sid);
      this.onclose?.({ code, reason });
    }
  }

  return {
    async fetch(input, init) {
      const url = new URL(input, base());
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (query[k] = v));
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      let body: unknown;
      if (typeof init?.body === 'string' && init.body) {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      const p = await port();
      const id = nextId++;
      const r = await new Promise<HubLinkResponse>((resolve) => {
        pending.set(id, resolve);
        p.postMessage({ k: 'req', id, req: { method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname.slice(Math.max(0, url.pathname.indexOf('/api/'))), query, headers, body } });
      });
      return new Response(r.type ? String(r.body) : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': r.type ?? 'application/json' } });
    },
    WebSocket: LinkSocket,
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    closeAll() {
      for (const s of [...sockets.values()]) s.close();
    },
  };
}

/** 窗口之间发消息的最小接口（这个包不依赖 DOM 类型） */
interface WindowLike {
  postMessage(message: unknown, targetOrigin: string): void;
}
interface PortEvent {
  data: unknown;
  ports: ReadonlyArray<HubPort & { start(): void }>;
}
interface EventTargetLike {
  addEventListener(type: 'message', fn: (ev: PortEvent) => void): void;
  removeEventListener(type: 'message', fn: (ev: PortEvent) => void): void;
}

/** 向另一个窗口（上层窗口或桥接 iframe）要一个中枢端口（对方用 servePortRequests 回应） */
export function requestHubPort(target: WindowLike, timeoutMs = 15_000): Promise<HubPort> {
  const self = globalThis as unknown as EventTargetLike;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      self.removeEventListener('message', onMsg);
      reject(new Error('no hub port'));
    }, timeoutMs);
    const onMsg = (ev: PortEvent) => {
      const d = ev.data as { k?: string } | undefined;
      const p = ev.ports[0];
      if (d?.k === PORT_REPLY && p) {
        clearTimeout(timer);
        self.removeEventListener('message', onMsg);
        p.start();
        resolve(p);
      }
    };
    self.addEventListener('message', onMsg);
    target.postMessage({ k: PORT_REQUEST }, '*');
  });
}
