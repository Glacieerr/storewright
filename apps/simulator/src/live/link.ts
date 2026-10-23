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

/**
 * 浏览器内演示：经过员工端的桥接页面（隐藏 iframe）连到浏览器里的门店中枢，与员工端的手机画面看到同一家店。
 * 桥接页面没有及时回应时，去掉这个 iframe、下一次重新建一个（决策记录 0015：原来失败一次就只能刷新页面）。
 */
function linkVia(bridgeUrl: string): HubLink {
  demoLink ??= createHubLink(
    () =>
      new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.src = bridgeUrl;
        frame.title = 'hub bridge';
        frame.style.display = 'none';
        frame.onload = () => {
          if (!frame.contentWindow) return;
          requestHubPort(frame.contentWindow).then(resolve, (e: unknown) => {
            frame.remove();
            reject(e);
          });
        };
        document.body.appendChild(frame);
      }),
  );
  return demoLink;
}

/** 连接失败后自动重试的等待时间（毫秒）；全部失败才显示错误 */
const DEMO_RETRY_MS = [1500, 4000, 8000];

export async function connectDemoLive(bridgeUrl: string, storeId: string): Promise<void> {
  disconnectLive();
  useApp.setState({ live: { status: 'connecting', url: 'demo', storeId } });
  try {
    const l = linkVia(bridgeUrl);
    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await l.fetch(`/api/stores/${encodeURIComponent(storeId)}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'viewer' }) });
        break;
      } catch (e) {
        const wait = DEMO_RETRY_MS[attempt];
        if (wait === undefined) throw e;
        await new Promise((r) => setTimeout(r, wait));
        // 期间又切换了门店或断开了：不再重试
        const live = useApp.getState().live;
        if (live.status !== 'connecting' || live.storeId !== storeId) return;
      }
    }
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
