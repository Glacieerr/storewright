import { LiveClient } from '@storewright/ops/client';
import { createHubLink, requestHubPort, type HubLink } from '@storewright/ops/hub-link';
import { useApp } from '../state/store';

/**
 * 门店实况：以查看者身份连接 Storewright 后端，订阅员工端产生的实时事件。
 * 客户端放在模块里（不进入 React 状态），每次变化只把 liveVersion 加一，界面据此重新渲染。
 */
let client: LiveClient | undefined;

export function liveClient(): LiveClient | undefined {
  return client;
}

export async function connectLive(url: string, storeId: string): Promise<void> {
  disconnectLive();
  const base = url.trim().replace(/\/$/, '');
  useApp.setState({ live: { status: 'connecting', url: base, storeId } });
  try {
    const res = await fetch(`${base}/api/stores/${encodeURIComponent(storeId)}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { token } = (await res.json()) as { token: string };
    const c = new LiveClient({
      baseUrl: base,
      storeId,
      token,
      onChange: () => {
        if (client !== c) return;
        const st = useApp.getState();
        const status = c.status === 'live' ? 'live' : c.status === 'connecting' ? 'connecting' : 'offline';
        useApp.setState({ liveVersion: st.liveVersion + 1, ...(st.live.status !== status ? { live: { ...st.live, status } } : {}) });
      },
    });
    client = c;
    c.connect();
  } catch (e) {
    useApp.setState({ live: { status: 'off', url: base, storeId, error: e instanceof Error ? e.message : String(e) } });
  }
}

let demoLink: HubLink | undefined;

/** 浏览器内演示：经过员工端的桥接页面（隐藏 iframe）连到浏览器里的门店中枢，与员工端的手机画面看到同一家店 */
function linkVia(bridgeUrl: string): HubLink {
  demoLink ??= createHubLink(
    () =>
      new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.src = bridgeUrl;
        frame.title = 'hub bridge';
        frame.style.display = 'none';
        frame.onload = () => {
          if (frame.contentWindow) requestHubPort(frame.contentWindow).then(resolve, reject);
        };
        document.body.appendChild(frame);
      }),
  );
  return demoLink;
}

export async function connectDemoLive(bridgeUrl: string, storeId: string): Promise<void> {
  disconnectLive();
  useApp.setState({ live: { status: 'connecting', url: 'demo', storeId } });
  try {
    const l = linkVia(bridgeUrl);
    const res = await l.fetch(`/api/stores/${encodeURIComponent(storeId)}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'viewer' }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { token } = (await res.json()) as { token: string };
    const c = new LiveClient({
      baseUrl: '',
      storeId,
      token,
      WebSocketImpl: l.WebSocket as unknown as typeof WebSocket,
      fetchImpl: l.fetch as unknown as typeof fetch,
      onChange: () => {
        if (client !== c) return;
        const st = useApp.getState();
        const status = c.status === 'live' ? 'live' : c.status === 'connecting' ? 'connecting' : 'offline';
        useApp.setState({ liveVersion: st.liveVersion + 1, ...(st.live.status !== status ? { live: { ...st.live, status } } : {}) });
      },
    });
    client = c;
    c.connect();
  } catch (e) {
    useApp.setState({ live: { status: 'off', url: 'demo', storeId, error: e instanceof Error ? e.message : String(e) } });
  }
}

export function disconnectLive(): void {
  client?.close();
  client = undefined;
  const st = useApp.getState();
  if (st.live.status !== 'off') useApp.setState({ live: { ...st.live, status: 'off' }, liveView: false, liveVersion: st.liveVersion + 1 });
}

/** 某个暂存格位里的实时框数（场景用） */
export function liveSlotCount(code: string): number {
  return client?.state.slots[code]?.length ?? 0;
}
