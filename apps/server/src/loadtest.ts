import { gzipSync } from 'node:zlib';
import { pickRows, suggestSlots, type AnyOpsEvent, type OpsCommand } from '@storewright/ops';
import { Hub } from './hub';
import { memoryStorage } from './storage';
import { openDb } from './db';
import { sqlStorage } from './eventStore';
import { webPlatform } from './platform';

/**
 * 大型店容量测试（决策记录 0014）：一家两层的大型店、300 名员工，全部在一个进程里跑（内存存储，不经过网络）。
 *
 *   1. 一整天的订单：ORDERS 张自取订单分批走完拣货 → 暂存 → 到店 → 交付，记录命令处理速度；
 *   2. 快照：一天结束时门店状态的大小（原始 / gzip）和最大的几部分；
 *   3. 开班：CLIENTS 台设备同时连上（每台收到快照）；
 *   4. 高峰：CONC 个员工同时提交 BURST 条命令，测量从提交到所有设备收到的时间、每台设备收到的消息数和字节数。
 *
 *   npm run loadtest -w @storewright/server
 *   CLIENTS=500 ORDERS=2000 BURST=5000 npm run loadtest -w @storewright/server
 *   DB=pglite ORDERS=300 npm run loadtest -w @storewright/server   # 每条命令真的写进数据库（内存里的 PGlite）
 *   DATABASE_URL=postgres://… npm run loadtest -w @storewright/server
 */
const CLIENTS = Number(process.env.CLIENTS ?? 300);
const ORDERS = Number(process.env.ORDERS ?? 1200);
const WAVE = Number(process.env.WAVE ?? 40);
const BURST = Number(process.env.BURST ?? 3000);
const CONC = Number(process.env.CONC ?? 60);
/** 平稳高峰：每秒多少条命令（300 人的门店忙的时候大约每人每 6～10 秒一次操作） */
const RATE = Number(process.env.RATE ?? 50);

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
};
const ms = (x: number) => `${x.toFixed(1)} ms`;
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

const DB = process.env.DATABASE_URL ? 'postgres' : process.env.DB === 'pglite' ? 'pglite' : 'memory';
const storage = DB === 'memory' ? memoryStorage() : sqlStorage(await openDb(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : {}));
console.log(`存储：${DB === 'memory' ? '内存（只测中枢本身）' : DB === 'pglite' ? '内存里的 PGlite（每条命令写数据库）' : 'PostgreSQL'}`);
const hub = await Hub.create({ storage, platform: webPlatform, demo: true, storeIds: ['large'], lazyStores: true });
const entry = await hub.store('large');
if (!entry) throw new Error('store');
const { runtime: rt, demo } = entry;
const roster = rt.statics.roster;
const byRole = (role: string) => roster.filter((a) => a.role === role).map((a) => a.id);
const pickers = byRole('PICK');
const stagers = byRole('STAGE');
const handoff = byRole('HANDOFF');
// 一天大约 10 小时、在现在结束（快照按现在的时间判断哪些作业已经完成超过一小时）
const STEP = Math.max(1, Math.round((10 * 3600_000) / (ORDERS * 26)));
let clock = Date.now() - 10 * 3600_000;
const cmdMs: number[] = [];
const submit = async (cmd: OpsCommand, actor: string) => {
  clock += STEP;
  const t0 = performance.now();
  const r = await rt.submit({ cmd, actor, at: clock });
  cmdMs.push(performance.now() - t0);
  if (!r.ok) throw new Error(`${cmd.type} by ${actor}: ${r.reject.code}`);
  return r;
};

console.log(`大型店：${roster.length} 名员工（拣货 ${pickers.length}、暂存 ${stagers.length}、交付 ${handoff.length}），暂存格位 ${rt.statics.slots.length} 个`);

// 1. 一整天的订单
const t1 = performance.now();
let made = 0;
while (made < ORDERS) {
  const wave: Array<{ id: string; code: string }> = [];
  for (let i = 0; i < WAVE && made < ORDERS; i++, made++) {
    const o = demo.makeOrder({ index: made, type: 'PICKUP', slotStart: clock + 60 * 60_000, maxLines: 6 });
    await submit({ type: 'CreateOrder', order: o.info, codeHash: o.codeHash }, 'console');
    await submit({ type: 'LockOrder', orderId: o.info.id }, 'console');
    wave.push({ id: o.info.id, code: o.code });
  }
  await submit({ type: 'ReleaseWalks' }, 'console');
  const walks = Object.values(rt.state.walks).filter((w) => w.status === 'OPEN');
  for (const [k, w] of walks.entries()) {
    const who = pickers[k % pickers.length] as string;
    await submit({ type: 'ClaimWalk', walkId: w.id }, who);
    for (const id of w.toteIds) await submit({ type: 'BindLabel', walkId: w.id, labelId: rt.state.totes[id]?.labelId ?? '' }, who);
    for (const r of pickRows(rt.state, rt.state.walks[w.id] as never)) if (!r.cancelled) await submit({ type: 'PickItem', walkId: w.id, toteId: r.toteId, lineId: r.lineId, qty: r.qty - r.done }, who);
    await submit({ type: 'CompleteWalk', walkId: w.id }, who);
  }
  for (const [k, o] of wave.entries()) {
    const order = rt.state.orders[o.id];
    if (!order) continue;
    const st = stagers[k % stagers.length] as string;
    for (const id of order.toteIds) await submit({ type: 'StageTote', labelId: rt.state.totes[id]?.labelId ?? '', slotCode: suggestSlots(rt.state, rt.statics, id)[0] ?? '' }, st);
    const h = handoff[k % handoff.length] as string;
    await submit({ type: 'CheckIn', orderId: o.id }, 'customer');
    await submit({ type: 'StartPrep', key: o.id }, h);
    for (const id of order.toteIds) await submit({ type: 'ScanPrepTote', key: o.id, labelId: rt.state.totes[id]?.labelId ?? '' }, h);
    await submit({ type: 'VerifyCode', key: o.id, code: o.code }, h);
    await submit({ type: 'CompleteHandoff', key: o.id, removeAgeItems: true }, h);
  }
}
const dayMs = performance.now() - t1;
console.log(`\n1) 一天的订单：${ORDERS} 张，${cmdMs.length} 条命令，用时 ${(dayMs / 1000).toFixed(1)} s（${Math.round(cmdMs.length / (dayMs / 1000))} 条/秒）；单条命令 p50 ${ms(q(cmdMs, 0.5))} · p95 ${ms(q(cmdMs, 0.95))} · p99 ${ms(q(cmdMs, 0.99))}`);

// 2. 快照
const stateJson = JSON.stringify(rt.state);
const parts = Object.entries(rt.state)
  .map(([k, v]) => [k, JSON.stringify(v).length] as const)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 6);
console.log(`2) 一天结束时的门店状态：${kb(stateJson.length)}（gzip ${kb(gzipSync(stateJson).length)}），静态数据 ${kb(JSON.stringify(rt.statics).length)}；最大的部分：${parts.map(([k, n]) => `${k} ${kb(n)}`).join('，')}`);

// 3. 开班：所有设备连上
const tokens: string[] = [];
for (let i = 0; i < CLIENTS; i++) {
  const r = await hub.handle({ method: 'POST', path: '/api/stores/large/session', query: {}, headers: {}, body: { associateId: roster[i % roster.length]?.id } });
  tokens.push((r.body as { token: string }).token);
}
let frames = 0;
let bytes = 0;
// 探针设备解析消息、跟踪序号（像真实客户端一样）；其余设备只统计收到的字节
const probes = new Map<number, number>();
const burstTypes = new Map<string, number>();
let counting = false;
const transport = (i: number) => (m: unknown) => {
  // 优化前中枢给的是对象（每台设备各序列化一次），优化后给的是共用的文本
  const raw = typeof m === 'string' ? m : JSON.stringify(m);
  frames++;
  bytes += raw.length;
  if (i >= CLIENTS - 3) {
    const msg = JSON.parse(raw) as { t: string; events?: AnyOpsEvent[]; state?: { seq: number } };
    if (msg.t === 'snapshot' && msg.state) probes.set(i, msg.state.seq);
    if (msg.t === 'events' && msg.events?.length) probes.set(i, Math.max(probes.get(i) ?? 0, msg.events.at(-1)?.seq ?? 0));
    if (counting && i === CLIENTS - 1 && msg.t === 'events') for (const ev of msg.events ?? []) burstTypes.set(ev.type, (burstTypes.get(ev.type) ?? 0) + 1);
  }
};
const t3 = performance.now();
const conns = [];
for (let i = 0; i < CLIENTS; i++) conns.push(await hub.connect('large', tokens[i], 0, transport(i)));
const connectMs = performance.now() - t3;
console.log(`3) 开班：${CLIENTS} 台设备连上用时 ${ms(connectMs)}（平均每台 ${ms(connectMs / CLIENTS)}），发出 ${kb(bytes)}`);
// 3b. 刷新页面后重新连上：设备已经有同一版本的静态数据（陈列表、库位、名单），快照里不再带
const known = (entry as { staticsJson?: { hash: string } }).staticsJson?.hash;
bytes = 0;
const t3b = performance.now();
const again = [];
for (let i = 0; i < CLIENTS; i++) again.push(await hub.connect('large', tokens[i], 0, transport(-1), known));
console.log(`   刷新后重新连上：${CLIENTS} 台用时 ${ms(performance.now() - t3b)}，每台 ${kb(bytes / CLIENTS)}（不再带静态数据）`);
for (const c of again) c?.close();

// 4. 高峰：大量员工同时操作（顾客上报到店时间：每条命令一个事件，推送给所有设备）
const open: string[] = [];
for (let i = 0; i < 200; i++) {
  const o = demo.makeOrder({ index: ORDERS + i, type: 'PICKUP', slotStart: clock + 120 * 60_000, maxLines: 3 });
  await submit({ type: 'CreateOrder', order: o.info, codeHash: o.codeHash }, 'console');
  open.push(o.info.id);
}
frames = 0;
bytes = 0;
counting = true;
clock = Date.now();
const lat: number[] = [];
let issued = 0;
const t4 = performance.now();
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (issued < BURST) {
      issued++;
      const orderId = open[issued % open.length] as string;
      const t0 = performance.now();
      clock += 10;
      const r = await rt.submit({ cmd: { type: 'UpdateEta', orderId, etaAt: clock + 15 * 60_000 }, actor: 'customer', at: clock });
      if (!r.ok) throw new Error(r.reject.code);
      const target = r.events.at(-1)?.seq ?? 0;
      while ([...probes.values()].some((s) => s < target)) await new Promise((res) => setImmediate(res));
      lat.push(performance.now() - t0);
    }
  }),
);
const burstMs = performance.now() - t4;
console.log(
  `4) 高峰：${CONC} 人同时提交 ${BURST} 条命令，用时 ${(burstMs / 1000).toFixed(2)} s（${Math.round(BURST / (burstMs / 1000))} 条/秒）；` +
    `提交到所有设备收到 p50 ${ms(q(lat, 0.5))} · p95 ${ms(q(lat, 0.95))} · p99 ${ms(q(lat, 0.99))}；` +
    `每台设备收到 ${Math.round(frames / CLIENTS)} 条消息、${kb(bytes / CLIENTS)}`,
);
console.log(`   高峰期间推送的事件：${[...burstTypes.entries()].map(([k, n]) => `${k} ${n}`).join('，')}`);

// 5. 平稳高峰：每秒 RATE 条命令，持续 6 秒（真实门店更接近这种节奏）
const steady: number[] = [];
const t5 = performance.now();
const total = RATE * 6;
await Promise.all(
  Array.from({ length: total }, async (_, k) => {
    await new Promise((res) => setTimeout(res, (k * 1000) / RATE));
    const orderId = open[k % open.length] as string;
    const t0 = performance.now();
    const r = await rt.submit({ cmd: { type: 'UpdateEta', orderId, etaAt: Date.now() + 20 * 60_000 }, actor: 'customer', at: Date.now() });
    if (!r.ok) throw new Error(r.reject.code);
    const target = r.events.at(-1)?.seq ?? 0;
    while ([...probes.values()].some((s) => s < target)) await new Promise((res) => setImmediate(res));
    steady.push(performance.now() - t0);
  }),
);
console.log(`5) 平稳高峰：每秒 ${RATE} 条命令、持续 ${((performance.now() - t5) / 1000).toFixed(1)} s；提交到所有设备收到 p50 ${ms(q(steady, 0.5))} · p95 ${ms(q(steady, 0.95))} · p99 ${ms(q(steady, 0.99))}`);
const heap = process.memoryUsage().heapUsed;
console.log(`内存：${(heap / 1024 / 1024).toFixed(0)} MB`);
for (const c of conns) c?.close();
hub.stop();
process.exit(0);
