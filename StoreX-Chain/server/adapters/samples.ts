import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { setRegion } from '../../src/region/network';
import { regionSpecFrom, regionSpecText } from '../../src/region/regionGen';
import { buildBoard } from '../../src/sim/board';
import { scenarioFor, withLoad } from '../../src/sim/config';
import { runChain } from '../../src/sim/engine';
import { allocationHour, emptyDay } from '../../src/sim/plan';
import { Loop } from '../../src/twin/loop';
import type { Msg } from '../../src/twin/types';
import { FEED_DATE, GEO, Refs } from './common';
import { ediFromEvents, portEventsFromPlan } from './edi';
import { readRecording, Recorder } from './recording';
import { tmsFromMsgs, tmsTrip } from './tms';
import { wmsFromMsgs } from './wms';

/**
 * 样例数据：模拟一天（StoreX 全链路 · 种子 4 · 第 87 天 · 默认区域 · 多事的一天 · 全部自动执行：有改门、提醒司机检查、
 * 3 趟追加补货），写到 server/adapters/samples/：
 * - day.jsonl.gz：完整的记录，回放用（--source replay:server/adapters/samples/day.jsonl.gz）；
 * - tms.jsonl、wms.csv、port.edi、meta.json：外部系统的样例（--source feed:server/adapters/samples）。
 *   为了文件小，运输管理的定位每 5 分钟一条（真实的车载终端一般更密），门店关门的时段（22 点到 7 点）没有收银记录。
 * 数据全是合成的。用法：npx tsx server/adapters/samples.ts
 */
const OUT = new URL('./samples/', import.meta.url);
const META = { gen: 'g3', seed: 4, level: 'rough', policy: 'auto', region: 'default', load: 'normal', day: 87 } as const;

setRegion(regionSpecFrom(META.region));
const s = withLoad(scenarioFor(META.gen, META.seed), META.load);
s.traceDay = META.day;
const trace = runChain(s).trace;
if (!trace) throw new Error('仿真没有记录这一天');
const board = buildBoard(trace.ops, emptyDay(), { allocation: allocationHour(s), crossDock: s.dc.crossDock });
const loop = new Loop({ vehicles: trace.vehicles, ops: board.ops, board, seed: META.seed, store: { stock: trace.storeStock, demand: trace.storeDemand }, direct: [...s.flow.direct], level: META.level }, { closed: true, policy: META.policy, decisions: [] });
const lines: string[] = [];
const rec = new Recorder((l) => lines.push(l));
// 表头的时间也用合成的日期，样例每次生成都一样
rec.attach(loop, { ...META, region: regionSpecText(regionSpecFrom(META.region)) }, `${FEED_DATE}T00:00:00`);
while (!loop.done) {
  loop.step();
  rec.check(loop);
}
const text = `${lines.join('\n')}\n`;
const regs = readRecording(text).vehicles;

mkdirSync(OUT, { recursive: true });
writeFileSync(new URL('day.jsonl.gz', OUT), gzipSync(text, { level: 9 }));

const refs = new Refs(board.ops, trace.vehicles);
const trips = regs.map((r) => JSON.stringify(tmsTrip(r, refs)));
// 定位每 5 分钟留一条
const last = new Map<number, number>();
const thin = loop.field.msgs.filter((m: Msg) => {
  if (m.kind !== 'gps') return true;
  if ((last.get(m.vid) ?? -Infinity) + 300 > m.t) return false;
  last.set(m.vid, m.t);
  return true;
});
writeFileSync(new URL('tms.jsonl', OUT), `${[...trips, ...tmsFromMsgs(thin, refs).map((x) => JSON.stringify(x))].join('\n')}\n`);
const open = (t: number) => Math.floor(t / 3600) % 24 >= 7 && Math.floor(t / 3600) % 24 < 22;
writeFileSync(new URL('wms.csv', OUT), wmsFromMsgs(loop.field.msgs.filter((m: Msg) => m.kind !== 'pos' || m.units > 0 || open(m.t)), refs));
writeFileSync(new URL('port.edi', OUT), ediFromEvents(portEventsFromPlan(board)));
writeFileSync(new URL('meta.json', OUT), `${JSON.stringify({ ...META, date: FEED_DATE, geoOrigin: GEO, note: '合成的样例数据：模拟一天的现场经过运输管理、仓储和门店、港口三个接口的格式；日期和经纬度原点都是合成的' }, null, 2)}\n`);

let total = 0;
for (const f of ['day.jsonl.gz', 'tms.jsonl', 'wms.csv', 'port.edi', 'meta.json']) {
  const n = statSync(new URL(f, OUT)).size;
  total += n;
  process.stdout.write(`${f.padEnd(14)} ${(n / 1024).toFixed(1).padStart(7)} KB\n`);
}
process.stdout.write(`合计 ${(total / 1024).toFixed(1)} KB · 记录 ${lines.length} 行（数据 ${loop.field.msgs.length} 条、指令 ${loop.cmds.length} 条、车 ${regs.length} 次登记）\n`);
