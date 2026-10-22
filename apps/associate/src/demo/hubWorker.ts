/// <reference lib="webworker" />
import { Hub, type HubConnection } from '@storewright/server/hub';
import { webPlatform } from '@storewright/server/platform';
import { memoryStorage } from '@storewright/server/storage';
import { persistentStorage } from './idbStorage';
import type { FromHub, ToHub } from '@storewright/ops/hub-link';

/**
 * 浏览器内演示模式的门店中枢：与本地后端完全相同的处理逻辑（apps/server/src/hub.ts），
 * 数据放在内存里（所有标签页都关闭后清空）。作为 SharedWorker 运行时，同一个网站的所有标签页和 iframe 共用一家店；
 * 不支持 SharedWorker 的浏览器作为专用 Worker 运行，展示页可以把额外的 MessagePort 交过来，让几个 iframe 共用。
 */

interface PortLike {
  postMessage(m: FromHub): void;
  onmessage: ((ev: MessageEvent<ToHub>) => void) | null;
  start?(): void;
}

let hubP: Promise<Hub> | undefined;
const ports = new Set<PortLike>();

function broadcast(m: FromHub): void {
  for (const p of ports) p.postMessage(m);
}

/** SharedWorker 里保存到 IndexedDB（刷新后门店还在）；专用 Worker 只放内存（几个 Worker 同时写会互相覆盖） */
const shared = typeof (globalThis as { SharedWorkerGlobalScope?: unknown }).SharedWorkerGlobalScope !== 'undefined' && self instanceof (globalThis as unknown as { SharedWorkerGlobalScope: new () => object }).SharedWorkerGlobalScope;

function getHub(): Promise<Hub> {
  hubP ??= (shared ? persistentStorage().then((x) => x.storage) : Promise.resolve(memoryStorage())).then((storage) => Hub.create({
    storage,
    platform: webPlatform,
    demo: true,
    storeIds: ['demo', 'hardware'],
    lazyStores: true,
    tickMs: 15_000,
    releaseMs: 60_000,
    log: (level, msg) => (level === 'error' ? console.error(msg) : console.warn(msg)),
  })).then((h) => {
    h.start();
    return h;
  });
  return hubP;
}

function serve(port: PortLike): void {
  ports.add(port);
  const conns = new Map<number, HubConnection>();
  port.onmessage = (ev) => {
    const m = ev.data;
    if (m.k === 'port') {
      const extra = ev.ports[0];
      if (extra) serve(extra as unknown as PortLike);
      return;
    }
    void (async () => {
      const hub = await getHub();
      if (m.k === 'req') {
        const storeId = /^\/api\/stores\/([^/]+)/.exec(m.req.path)?.[1];
        // 第一次用到某家店时要建店并训练 AI 模型（几秒），先告诉页面
        const fresh = !!storeId && hub.storeIds.includes(decodeURIComponent(storeId)) && !hub.stores.has(decodeURIComponent(storeId));
        if (fresh) broadcast({ k: 'status', text: 'training' });
        const res = await hub.handle(m.req);
        port.postMessage({ k: 'res', id: m.id, res });
        if (fresh) broadcast({ k: 'status', text: 'ready' });
      } else if (m.k === 'open') {
        const conn = await hub.connect(m.storeId, m.token, m.after, (msg) => port.postMessage({ k: 'msg', sid: m.sid, data: JSON.stringify(msg) }));
        if (!conn) port.postMessage({ k: 'closed', sid: m.sid, code: 4401, reason: 'unauthorized' });
        else conns.set(m.sid, conn);
      } else if (m.k === 'send') conns.get(m.sid)?.receive(m.data);
      else if (m.k === 'close') {
        conns.get(m.sid)?.close();
        conns.delete(m.sid);
      }
    })().catch((err: unknown) => console.error(err));
  };
  port.start?.();
}

const scope = self as unknown as { onconnect?: (e: MessageEvent) => void; postMessage: (m: FromHub) => void };
if (shared) {
  scope.onconnect = (e) => {
    const p = e.ports[0];
    if (p) serve(p as unknown as PortLike);
  };
} else {
  serve(self as unknown as PortLike);
}
