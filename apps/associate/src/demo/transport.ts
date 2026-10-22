import { createHubLink, PORT_REPLY, PORT_REQUEST, requestHubPort, type HubPort } from '@storewright/ops/hub-link';

/**
 * 浏览器内演示模式（决策记录 0010 第 7 节）：不需要后端，门店中枢在浏览器里运行（SharedWorker），
 * 同一个网站打开的所有标签页和 iframe 共用一家店，实时同步。
 *
 * 打开方式：用 `npm run build:demo -w @storewright/associate` 构建（VITE_DEMO=1），或者在地址栏加 `?demo`（之后在这个标签页里一直有效）。
 * 页面里的 /api 请求和 WebSocket 都转给中枢，其他代码不用改。
 */

const FLAG = 'storewright.demo';

function detect(): boolean {
  if (import.meta.env.VITE_DEMO === '1') return true;
  try {
    if (new URLSearchParams(location.search).has('demo')) sessionStorage.setItem(FLAG, '1');
    return sessionStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
}

export const DEMO = typeof window !== 'undefined' && detect();

let dedicated: Worker | undefined;

/** 本页的中枢端口：优先 SharedWorker；不支持时，iframe 向上层窗口要一个端口，否则在本页开一个专用 Worker */
export async function hubPort(): Promise<HubPort> {
  if (typeof SharedWorker !== 'undefined') {
    const w = new SharedWorker(new URL('./hubWorker.ts', import.meta.url), { type: 'module', name: 'storewright-demo-hub' });
    w.port.start();
    return w.port as unknown as HubPort;
  }
  if (window.parent !== window) {
    try {
      return await requestHubPort(window.parent, 5000);
    } catch {
      // 上层窗口不提供：退回到本页的专用 Worker
    }
  }
  dedicated ??= new Worker(new URL('./hubWorker.ts', import.meta.url), { type: 'module', name: 'storewright-demo-hub' });
  return dedicated as unknown as HubPort;
}

/** 给另一个窗口（iframe、模拟器的桥接页面）一个连到同一个中枢的新端口 */
export async function portForAnotherWindow(): Promise<MessagePort> {
  const ch = new MessageChannel();
  const p = typeof SharedWorker !== 'undefined' ? (new SharedWorker(new URL('./hubWorker.ts', import.meta.url), { type: 'module', name: 'storewright-demo-hub' }).port as MessagePort) : (await hubPort()) as unknown as Worker;
  if ('start' in p && typeof p.start === 'function') p.start();
  (p as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage({ k: 'port' }, [ch.port1]);
  return ch.port2;
}

/** 回应 iframe 的端口请求（展示页、桥接页面使用） */
export function servePortRequests(): void {
  window.addEventListener('message', (ev: MessageEvent) => {
    if ((ev.data as { k?: string } | undefined)?.k !== PORT_REQUEST || !ev.source) return;
    void portForAnotherWindow().then((p) => (ev.source as Window).postMessage({ k: PORT_REPLY }, '*', [p]));
  });
}

export const link = createHubLink(hubPort);

/** 演示模式下把页面里的 /api 请求转给中枢；关闭页面时断开实时连接 */
export function installDemoTransport(): void {
  if (!DEMO) return;
  const real = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url, location.href).pathname.includes('/api/')) return link.fetch(url, init);
    return real(input, init);
  };
  window.addEventListener('pagehide', () => link.closeAll());
}
