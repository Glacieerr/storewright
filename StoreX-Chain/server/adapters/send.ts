import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { adapterOf } from './common';
import { postsOf, splitRecords, type IngestAdapter, type SendRecord } from './live';

/**
 * 发送脚本：把外部系统的文件（运输管理 *.jsonl、仓储和门店 *.csv、港口 *.edi）按数据自己的时刻推给孪生服务的实时接入，
 * 模拟外部系统一边发生一边推数据。孪生服务要用 --source live（或 live:<meta.json>、watch:<目录>）启动。
 *
 *   npx tsx server/adapters/send.ts --to http://127.0.0.1:8787 --from server/adapters/samples --speed 60
 *
 * --speed 每秒推几分钟的数据（和孪生服务的 --speed 一个意思；0 = 不等，按时刻顺序尽快推完）；
 * --token 密钥（孪生服务设了 --ingest-token 时要带；也可以用环境变量 STOREX_INGEST_TOKEN）；
 * --start / --end 只推当天几点（含）到几点（不含）的数据（小时，可以带小数，默认全部）；--max 一次最多推几条（默认 2000）；
 * --window 每次推的数据最多跨几秒（默认 60，不要超过孪生服务的 --lateness）。
 * 三个系统是分开推的：每一批先按时间切成不超过 window 秒的段，每段按接口分开推，同一段里运输管理在前（它登记的新车，
 * 仓储系统和港口的记录要用）；这样孪生在两次推送之间往前走，也走不过还没推的数据，不会把别的系统的数据挤成「晚到」。
 * 推完打印每个接口收了多少、拒了多少。
 */
const argv = process.argv;
const has = (name: string): boolean => argv.includes(`--${name}`);
const arg = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? def) : def;
};
const TO = arg('to', 'http://127.0.0.1:8787').replace(/\/+$/, '');
const FROM = arg('from', 'server/adapters/samples');
const SPEED = Math.max(0, Number(arg('speed', '60')) || 0);
const TOKEN = has('token') ? arg('token', '') : process.env.STOREX_INGEST_TOKEN;
const MAX = Math.max(1, Number(arg('max', '2000')) || 2000);
const WINDOW = Math.max(1, Number(arg('window', '60')) || 60);
const FROM_T = has('start') ? Number(arg('start', '0')) * 3600 : -Infinity;
const TO_T = has('end') ? Number(arg('end', '26')) * 3600 : Infinity;
const TICK = 250;
const LABEL: Record<IngestAdapter, string> = { tms: '运输管理', wms: '仓储和门店', edi: '港口 EDI' };
const hhmm = (t: number) => {
  const m = Math.floor(t / 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
};

const files = readdirSync(FROM)
  .filter((n) => adapterOf(n) && statSync(join(FROM, n)).isFile())
  .sort()
  .map((n) => ({ name: n, text: readFileSync(join(FROM, n), 'utf8') }));
const all = splitRecords(files).filter((r) => r.t >= FROM_T && r.t < TO_T);
if (!all.length) {
  process.stderr.write(`${FROM} 里没有可以推的记录（*.jsonl、*.csv、*.edi）\n`);
  process.exit(1);
}

const total: Record<IngestAdapter, { sent: number; accepted: number; rejected: number }> = { tms: { sent: 0, accepted: 0, rejected: 0 }, wms: { sent: 0, accepted: 0, rejected: 0 }, edi: { sent: 0, accepted: 0, rejected: 0 } };
const reasons = new Map<string, number>();
let queued = 0;
let posts = 0;

/** 推一批；服务拒了整批（密钥不对、数据来源不收……）就停 */
async function post(adapter: IngestAdapter, text: string, n: number): Promise<void> {
  const res = await fetch(`${TO}/api/ingest/${adapter}`, {
    method: 'POST',
    headers: { 'content-type': adapter === 'wms' ? 'text/csv; charset=utf-8' : adapter === 'tms' ? 'application/x-ndjson; charset=utf-8' : 'application/edifact; charset=utf-8', ...(TOKEN ? { 'x-ingest-token': TOKEN } : {}) },
    body: text,
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; accepted?: number; rejected?: number; reasons?: { reason: string }[]; queued?: number };
  if (!res.ok) throw new Error(`${LABEL[adapter]}：HTTP ${res.status} ${body.error ?? ''}`);
  total[adapter].sent += n;
  total[adapter].accepted += body.accepted ?? 0;
  total[adapter].rejected += body.rejected ?? 0;
  for (const r of body.reasons ?? []) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
  queued = body.queued ?? queued;
  posts++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function main(): Promise<void> {
  const first = (all[0] as SendRecord).t;
  let dataT = Number.isFinite(FROM_T) ? FROM_T : first;
  let i = 0;
  let hour = Math.floor(dataT / 3600);
  const t0 = Date.now();
  process.stdout.write(`推给 ${TO}：${files.map((f) => f.name).join('、')}，${all.length} 条，数据从 ${hhmm(first)} 到 ${hhmm((all[all.length - 1] as SendRecord).t)}，${SPEED ? `每秒 ${SPEED} 分钟` : '不等，尽快推完'}\n`);
  while (i < all.length) {
    if (SPEED > 0) {
      await sleep(TICK);
      dataT += (SPEED * 60 * TICK) / 1000;
    } else dataT = Infinity;
    const batch: SendRecord[] = [];
    while (i < all.length && (all[i] as SendRecord).t <= dataT && batch.length < MAX) batch.push(all[i++] as SendRecord);
    for (const b of postsOf(batch, WINDOW, MAX)) await post(b.adapter, b.text, b.n);
    const at = i ? Math.min(dataT, (all[i - 1] as SendRecord).t) : dataT;
    if (Math.floor(at / 3600) > hour) {
      hour = Math.floor(at / 3600);
      process.stdout.write(`  数据到 ${hhmm(at)} · 推了 ${i} 条 · 孪生那边还在排队的 ${queued} 条\n`);
    }
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`推完：${sec} 秒，推了 ${posts} 次\n`);
  for (const a of ['tms', 'wms', 'edi'] as const) if (total[a].sent) process.stdout.write(`  ${LABEL[a]}：推了 ${total[a].sent} 条，收了 ${total[a].accepted}，拒了 ${total[a].rejected}\n`);
  for (const [r, n] of reasons) process.stdout.write(`  拒掉的原因：${r} × ${n}\n`);
}

main().catch((err: unknown) => {
  const cause = (err as { cause?: { code?: string } }).cause?.code;
  process.stderr.write(`推不上去：${cause === 'ECONNREFUSED' ? `连不上 ${TO}（孪生服务要用 --source live 启动）` : err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
