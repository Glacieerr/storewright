import { describe, expect, it } from 'vitest';
import { createHubLink, type FromHub, type HubPort, type ToHub } from './hubLink';

/** 假的门店中枢端口：收到请求就回一个 200 */
function fakePort(): HubPort {
  const p: HubPort = {
    onmessage: null,
    postMessage(m: ToHub) {
      if (m.k !== 'req') return;
      queueMicrotask(() => p.onmessage?.({ data: { k: 'res', id: m.id, res: { status: 200, body: { ok: true, path: m.req.path } } } as FromHub }));
    },
  } as HubPort;
  return p;
}

describe('in-browser hub link (decision 0015)', () => {
  it('does not keep a failed connection attempt: the next request tries again', async () => {
    let calls = 0;
    const link = createHubLink(async () => {
      calls++;
      if (calls === 1) throw new Error('bridge did not answer');
      return fakePort();
    });
    await expect(link.fetch('/api/stores/demo/session', { method: 'POST' })).rejects.toThrow('bridge did not answer');
    const res = await link.fetch('/api/stores/demo/session', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, path: '/api/stores/demo/session' });
    // 连上以后不再重复去拿端口
    await link.fetch('/api/health');
    expect(calls).toBe(2);
  });
});
