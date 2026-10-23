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

/** SharedWorker 里保存到 IndexedDB（刷新后门店还在） */
const shared = typeof (globalThis as { SharedWorkerGlobalScope?: unknown }).SharedWorkerGlobalScope !== 'undefined' && self instanceof (globalThis as unknown as { SharedWorkerGlobalScope: new () => object }).SharedWorkerGlobalScope;
/** 专用 Worker 拿不到写入锁：另一个标签页已经在用演示门店，这个标签页的门店是单独的、只放内存 */
let isolated = false;

/**
 * 专用 Worker（不支持 SharedWorker 的浏览器）也保存到 IndexedDB，但同一时间只能有一个写入者：先用 Web Locks 拿锁，
 * 拿到了（通常是唯一打开的标签页或展示页）才保存，一直持有到 Worker 结束；拿不到就只放内存，并告诉页面。
 */
async function chooseStorage() {
  if (shared) return (await persistentStorage()).storage;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) return memoryStorage();
  const got = await new Promise<boolean>((resolve) => {
    void locks.request('storewright-demo-store', { ifAvailable: true }, (lock) => {
      resolve(!!lock);
      // 拿到锁时一直持有（这个 Promise 不会结束），Worker 结束时浏览器自动释放
      return lock ? new Promise<void>(() => undefined) : undefined;
    });
  });
  if (!got) {
    isolated = true;
    return memoryStorage();
  }
  return (await persistentStorage()).storage;
}

function getHub(): Promise<Hub> {
  hubP ??= chooseStorage().then((storage) => Hub.create({
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
  void getHub().then(() => {
    if (isolated) port.postMessage({ k: 'status', text: 'isolated' });
  });
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
        // 中枢给的是已经序列化好的文本（同一条推送所有标签页共用一份）
        const conn = await hub.connect(m.storeId, m.token, m.after, (frame) => port.postMessage({ k: 'msg', sid: m.sid, data: frame }), m.statics);
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
