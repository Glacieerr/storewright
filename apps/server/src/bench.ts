import { LiveClient } from '@storewright/ops/client';

/**
 * 同步延迟测量：模拟「两台手机 + 一台电脑」。
 * 一台设备提交命令，测量其他两台设备收到对应事件的时间（命令提交 → 推送到达）。
 *
 *   npm run bench -w @storewright/server            # 对 http://localhost:8787 的 demo 门店
 *   BASE=http://192.168.1.20:8787 N=300 npm run bench -w @storewright/server
 */
const BASE = process.env.BASE ?? 'http://localhost:8787';
const STORE = process.env.STORE ?? 'demo';
const N = Number(process.env.N ?? 200);

async function session(body: Record<string, string>): Promise<string> {
  const r = await fetch(`${BASE}/api/stores/${STORE}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return ((await r.json()) as { token: string }).token;
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 1));
  }
}

const consoleToken = await session({ role: 'console' });
const devices = [new LiveClient({ baseUrl: BASE, storeId: STORE, token: await session({ associateId: 'A05' }) }), new LiveClient({ baseUrl: BASE, storeId: STORE, token: await session({ associateId: 'A06' }) }), new LiveClient({ baseUrl: BASE, storeId: STORE, token: await session({ role: 'viewer' }) })];
for (const d of devices) d.connect();
await until(() => devices.every((d) => d.status === 'live' && d.statics));

// 准备一张订单用来上报「我在路上」（只改 ETA，不影响其他数据）
const created = (await (await fetch(`${BASE}/api/stores/${STORE}/demo/orders`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${consoleToken}` }, body: JSON.stringify({ type: 'PICKUP', maxLines: 1 }) })).json()) as { orders: Array<{ orderId: string }> };
const orderId = created.orders[0]?.orderId ?? '';
await until(() => devices.every((d) => !!d.state.orders[orderId]));

const samples: number[] = [];
for (let i = 0; i < N; i++) {
  const target = Math.max(...devices.map((d) => d.state.seq)) + 1;
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/stores/${STORE}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${consoleToken}` },
    body: JSON.stringify({ cmd: { type: 'UpdateEta', orderId, etaAt: Date.now() + 10 * 60_000 } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // 每台设备各记一个样本
  const pending = new Set(devices);
  while (pending.size) {
    for (const d of pending) {
      if (d.state.seq >= target) {
        samples.push(performance.now() - t0);
        pending.delete(d);
      }
    }
    if (performance.now() - t0 > 5000) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 0));
  }
}
for (const d of devices) d.close();
samples.sort((a, b) => a - b);
const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] ?? 0;
console.log(`devices 3 · commands ${N} · samples ${samples.length}`);
console.log(`p50 ${q(0.5).toFixed(1)} ms · p95 ${q(0.95).toFixed(1)} ms · p99 ${q(0.99).toFixed(1)} ms · max ${(samples.at(-1) ?? 0).toFixed(1)} ms`);
process.exit(q(0.95) < 200 ? 0 : 1);
