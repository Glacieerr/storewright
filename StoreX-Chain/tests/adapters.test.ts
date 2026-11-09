import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adapterOf, AdapterStats, fromLatLon, fromTs, Refs, registerExtras, toLatLon, toTs, type VehicleReg } from '../server/adapters/common';
import { checkDigit, ContainerBook, containerId, ediFromEvents, msgToPortEvent, parseEdi, portEventsFromPlan, portEventToMsg, validContainer } from '../server/adapters/edi';
import { DirTail, handleIngest, ingestMessage, postsOf, splitRecords, tokenOk, type IngestHost, type SendRecord } from '../server/adapters/live';
import { ObservedField, swapField } from '../server/adapters/observed';
import { Outbox } from '../server/adapters/outbox';
import { readRecording, Recorder } from '../server/adapters/recording';
import { costOf, DataSource, loadFeed, loadFeedDir, parseSource } from '../server/adapters/source';
import { parseTms, tmsFromMsgs, tmsInstruction, tmsTrip } from '../server/adapters/tms';
import { parseWms, WMS_HEADER, wmsFromMsgs, wmsTask } from '../server/adapters/wms';
import { Assistant } from '../src/assistant';
import { STORE } from '../src/region/network';
import { buildBoard } from '../src/sim/board';
import { g3, scenarioFor, withLoad, type LoadLevel } from '../src/sim/config';
import { runChain } from '../src/sim/engine';
import { allocationHour, emptyDay } from '../src/sim/plan';
import type { FieldLevel } from '../src/twin/field';
import { Loop, type LoopInput } from '../src/twin/loop';
import type { Cmd, Msg, Policy, UserDecision } from '../src/twin/types';

/** 对接真实系统：运输管理、仓储和门店、港口 EDI 三个接口的进出换算，记录和回放，外部系统数据驱动孪生，实时接入 */
const SAMPLES = fileURLToPath(new URL('../server/adapters/samples/', import.meta.url));
const worlds = new Map<number, { trace: NonNullable<ReturnType<typeof runChain>['trace']>; board: ReturnType<typeof buildBoard>; direct: readonly string[] }>();
function world(day = 86) {
  let w = worlds.get(day);
  if (!w) {
    const s = g3(1);
    s.traceDay = day;
    const trace = runChain(s).trace!;
    w = { trace, board: buildBoard(trace.ops, emptyDay(), { allocation: allocationHour(s), crossDock: s.dc.crossDock }), direct: s.flow.direct };
    worlds.set(day, w);
  }
  return w;
}
const { trace, board } = world(86);
interface Run {
  level: FieldLevel;
  policy: Policy;
  day?: number;
  seed?: number;
  decisions?: UserDecision[];
}
const input = (r: Run): LoopInput => {
  const w = world(r.day);
  return { vehicles: w.trace.vehicles, ops: w.board.ops, board: w.board, seed: r.seed ?? 1, store: { stock: w.trace.storeStock, demand: w.trace.storeDemand }, direct: w.direct, level: r.level };
};
const meta = (r: Run) => ({ gen: 'g3', seed: r.seed ?? 1, level: r.level, policy: r.policy, region: 'default', load: 'normal', day: r.day ?? 86 });

/** 跑一整天模拟的现场，边跑边记 */
function live(r: Run): { loop: Loop; text: string } {
  const loop = new Loop(input(r), { closed: true, policy: r.policy, decisions: r.decisions ?? [] });
  const lines: string[] = [];
  const rec = new Recorder((l) => lines.push(l));
  rec.attach(loop, meta(r));
  while (!loop.done) {
    loop.step();
    rec.check(loop);
  }
  return { loop, text: lines.join('\n') };
}

/** 换上「看到的现场」，按记录或外部系统的数据跑一整天 */
function observed(r: Run, feed: ConstructorParameters<typeof ObservedField>[1]): { loop: Loop; field: ObservedField } {
  const loop = new Loop(input(r), { closed: true, policy: r.policy, decisions: r.decisions ?? [] });
  const stats = new Map([['replay', new AdapterStats('replay')], ['tms', new AdapterStats('tms')], ['wms', new AdapterStats('wms')], ['edi', new AdapterStats('edi')]] as const);
  const field = new ObservedField(loop.field, feed, world(r.day).board, (c) => costOf(loop, c), stats);
  swapField(loop, field);
  while (!loop.done) {
    loop.step();
    field.sync(loop.t);
  }
  return { loop, field };
}

const cardsOf = (loop: Loop) => loop.cards().map((r) => ({ key: r.key, t: r.t, status: r.status, by: r.by, chosen: r.chosen, doneAt: r.doneAt, interim: r.interim, best: r.best }));
const allMsgs = (loop: Loop): Msg[] => loop.field.msgs;

describe('记录和回放', () => {
  const runs: [string, Run][] = [
    ['多事的一天 · 低风险的自动执行', { level: 'rough', policy: 'safe' }],
    ['多事的一天 · 全部自动执行', { level: 'rough', policy: 'auto' }],
    ['平常的一天 · 全部自动执行', { level: 'normal', policy: 'auto' }],
    ['第 87 天 · 追加补货 3 趟（孪生派出来的车）', { level: 'rough', policy: 'auto', day: 87, seed: 4 }],
    ['调度员批准派救援车', { level: 'rough', policy: 'manual', decisions: [{ t: 11700, key: 'breakdown:16', action: 'approve', option: 'rescue' }] }],
  ];
  it('记录不改变闭环：记着和不记跑出来的数据、建议卡、指令完全一样', () => {
    const r: Run = { level: 'rough', policy: 'auto', day: 87, seed: 4 };
    const a = live(r);
    const plain = new Loop(input(r), { closed: true, policy: r.policy, decisions: [] });
    while (!plain.done) plain.step();
    expect(cardsOf(plain)).toEqual(cardsOf(a.loop));
    expect(JSON.stringify(plain.cmds)).toBe(JSON.stringify(a.loop.cmds));
    expect(JSON.stringify(plain.field.msgs)).toBe(JSON.stringify(a.loop.field.msgs));
  });

  it('数据来源的写法：sim、replay:<文件>、feed:<目录>、live、live:<meta.json>、watch:<目录>，写错了说清楚', () => {
    expect(parseSource(undefined)).toEqual({ mode: 'sim' });
    expect(parseSource('replay:/no/such/file.jsonl')).toEqual({ error: '找不到记录文件 /no/such/file.jsonl' });
    expect(parseSource('feed:/no/such/dir')).toEqual({ error: '找不到目录 /no/such/dir' });
    expect(parseSource('live')).toEqual({ mode: 'live' });
    expect(parseSource(`live:${SAMPLES}meta.json`)).toEqual({ mode: 'live', meta: `${SAMPLES}meta.json` });
    expect(parseSource('live:/no/such/meta.json')).toEqual({ error: '找不到计划文件 /no/such/meta.json' });
    expect(parseSource(`watch:${SAMPLES}`)).toEqual({ mode: 'watch', dir: SAMPLES });
    expect(parseSource('watch:/no/such/dir')).toEqual({ error: '找不到目录 /no/such/dir' });
    expect('error' in parseSource('kafka:topic')).toBe(true);
    expect(readRecording('{"type":"msg","step":0}\nnot json\n').rejected.map((x) => x.reason)).toEqual(['不认识或不完整的记录', '不是合法的 JSON']);
  });

  for (const [name, r] of runs)
    it(`回放（${name}）：孪生收到同样的数据，出同样的建议卡、发同样的指令`, () => {
      const a = live(r);
      const rec = readRecording(a.text);
      expect(rec.rejected).toHaveLength(0);
      expect(rec.meta?.policy).toBe(r.policy);
      const b = observed(r, { steps: rec.steps, vehicles: rec.vehicles });
      expect(cardsOf(b.loop)).toEqual(cardsOf(a.loop));
      expect(JSON.stringify(b.loop.cmds)).toBe(JSON.stringify(a.loop.cmds));
      expect(b.loop.field.msgs.length).toBe(rec.msgs);
      // 孪生派出来的车（救援车、追加补货车）回放时也登记上了
      expect(b.loop.field.fv.filter((f) => f.extra).map((f) => f.vid)).toEqual(a.loop.field.fv.filter((f) => f.extra).map((f) => f.vid));
      if (name.includes('救援')) expect(a.loop.cmds.some((c) => c.kind === 'rescue')).toBe(true);
      if (name.includes('补货')) expect(a.loop.cmds.filter((c) => c.kind === 'restock').length).toBeGreaterThanOrEqual(2);
    });
});

/** 两条感知数据在换算误差以内相同（时刻 1 毫秒，坐标 1 厘米，读数千分之一） */
function close(a: Msg, b: Msg): boolean {
  if (a.kind !== b.kind) return false;
  const ka = a as unknown as Record<string, unknown>;
  const kb = b as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ka), ...Object.keys(kb)])) {
    const x = ka[k];
    const y = kb[k];
    if (typeof x === 'number' && typeof y === 'number') {
      const tol = k === 't' || k === 'eta' || k === 'until' ? 0.002 : k === 'x' || k === 'z' ? 0.01 : 0.002;
      if (Math.abs(x - y) > tol) return false;
    } else if (x !== y) return false;
  }
  return true;
}

describe('换算：模拟的数据 → 外部系统的格式 → 感知数据', () => {
  const a = live({ level: 'rough', policy: 'auto', day: 87, seed: 4 });
  const w = world(87);
  const msgs = allMsgs(a.loop);
  const refsFor = () => {
    const refs = new Refs(w.board.ops, w.trace.vehicles);
    return refs;
  };

  it('时刻和经纬度换过去再换回来几乎不变', () => {
    for (const t of [0, 1.5, 3599.999, 86399, 93600.25]) expect(fromTs(toTs(t))).toBeCloseTo(t, 3);
    expect(toTs(9 * 3600)).toBe('2030-03-28T09:00:00');
    expect(toTs(25 * 3600)).toBe('2030-03-29T01:00:00');
    const p = toLatLon(652.4, -507.9);
    const q = fromLatLon(p.lat, p.lon);
    expect(q.x).toBeCloseTo(652.4, 6);
    expect(q.z).toBeCloseTo(-507.9, 6);
  });

  it('运输管理（定位、车载终端事件、冷机、电量、路况）：一条不少，数值在误差以内', () => {
    const refs = refsFor();
    const regs = readRecording(a.text).vehicles;
    // 孪生派出来的车先登记编号（新行程记录），后面的定位才认得
    const trips = regs.filter((r) => !r.replan).map((r) => JSON.stringify(tmsTrip(r, refs)));
    const kinds = new Set(['gps', 'event', 'temp', 'soc', 'traffic']);
    const mine = msgs.filter((m) => kinds.has(m.kind) && !(m.kind === 'event' && m.place === 'PORT'));
    const text = [...trips, ...tmsFromMsgs(mine, refs).map((x) => JSON.stringify(x))].join('\n');
    const back = parseTms(text, new Refs(w.board.ops, w.trace.vehicles));
    expect(back.rejected).toEqual([]);
    expect(back.items).toHaveLength(mine.length);
    mine.forEach((m, i) => expect(close(m, (back.items[i] as { m: Msg }).m), JSON.stringify([m, back.items[i]?.m])).toBe(true));
    expect(back.vehicles.map((v) => [v.vid, v.extra?.kind, v.extra?.fam])).toEqual(regs.filter((r) => !r.replan).map((r) => [r.vid, r.extra?.kind, r.extra?.fam]));
    const v0 = regs.find((r) => !r.replan) as VehicleReg;
    const b0 = back.vehicles[0] as VehicleReg;
    expect(b0.v.segs).toHaveLength(v0.v.segs.length);
    v0.v.segs.forEach((sg, i) => {
      expect(Math.abs((b0.v.segs[i]?.t0 ?? 0) - sg.t0)).toBeLessThan(0.002);
      sg.pts.forEach((x, k) => expect(Math.abs((b0.v.segs[i]?.pts[k] ?? NaN) - x)).toBeLessThan(0.01));
    });
  });

  it('仓储和门店（门磁、装车扫描、盘点、收银）：一条不少，完全相同', () => {
    const refs = refsFor();
    registerExtras(refs, readRecording(a.text).vehicles);
    const mine = msgs.filter((m) => m.kind === 'door' || m.kind === 'load' || m.kind === 'stock' || m.kind === 'pos');
    const csv = wmsFromMsgs(mine, refs);
    expect(csv.split('\n')[0]).toBe('ts,event,site,door,vehicle_ref,done,total,family,units');
    const back = parseWms(csv, refs);
    expect(back.rejected).toEqual([]);
    expect(back.items).toHaveLength(mine.length);
    mine.forEach((m, i) => expect(close(m, (back.items[i] as { m: Msg }).m)).toBe(true));
  });

  it('港口 EDI：按计划编的本店箱的事件写成报文再读回来，事件和感知数据都相同；箱号按 ISO 6346 校验', () => {
    expect(checkDigit('CSQU305438')).toBe(3);
    expect(validContainer('CSQU3054383')).toBe(true);
    expect(validContainer('CSQU3054384')).toBe(false);
    expect(validContainer(containerId(86001))).toBe(true);
    const refs = new Refs(board.ops, trace.vehicles);
    const events = portEventsFromPlan(board);
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(new Set(events.map((e) => e.code))).toContain('DISCHARGE');
    const edi = ediFromEvents(events);
    expect(edi).toMatch(/^UNA:\+\.\? '/);
    expect(edi).toContain('COARRI:D:95B:UN');
    expect(edi).toContain('IFTSTA:D:95B:UN');
    const back = parseEdi(edi, refs);
    expect(back.rejected).toEqual([]);
    expect(back.events).toEqual(events);
    expect(back.items.map((x) => x.m)).toEqual(events.map((e) => portEventToMsg(e, refs)));
    // 感知数据 → 事件 → 感知数据
    for (const e of events) expect(msgToPortEvent(portEventToMsg(e, refs), refs)).toMatchObject({ code: e.code, container: e.container, t: e.t });
  });

  it('孪生的每种指令都换算成运输管理的调度指令或仓储系统的任务（恰好一种）', () => {
    const refs = refsFor();
    const all: Cmd[] = [
      { kind: 'notifyStore', t: 100, store: 'S01', until: 36000 },
      { kind: 'resequence', t: 100, vid: 16, order: ['S01'] },
      { kind: 'rescue', t: 100, vid: 16 },
      { kind: 'driverCheck', t: 100, vid: 16 },
      { kind: 'setpoint', t: 100, vid: 19, delta: -2 },
      { kind: 'reassignDoor', t: 100, vid: 16, door: 'C07' },
      { kind: 'restock', t: 100, fam: 'DAIRY', units: 1200 },
      { kind: 'divert', t: 100, vid: 1, to: 'store' },
      { kind: 'hold', t: 100, vid: 1, until: 40000 },
    ];
    for (const c of all) expect([tmsInstruction(c, refs), wmsTask(c, refs)].filter(Boolean)).toHaveLength(1);
    const stats = new Map([['tms', new AdapterStats('tms')], ['wms', new AdapterStats('wms')]] as const);
    const box = new Outbox(refs, stats);
    box.sync(all);
    expect(box.list).toHaveLength(all.length);
    expect(stats.get('wms')?.sent).toBe(2);
    expect(box.list.find((x) => x.cmd.kind === 'restock')?.out).toMatchObject({ task: 'REPLENISH', family: 'DAIRY', units: 1200 });
  });
});

describe('坏数据：跳过并记下原因，不影响好的', () => {
  const refs = new Refs(board.ops, trace.vehicles);
  it('运输管理', () => {
    const r = parseTms(
      [
        '{"type":"position","ts":"2030-03-28T09:00:00","vehicleRef":"M02","lat":0.01,"lon":0.02}',
        '{"type":"position","ts":"2030-03-28T09:00:00","vehicleRef":"NOPE","lat":0.01,"lon":0.02}',
        '{"type":"position","ts":"9点","vehicleRef":"M02","lat":0.01,"lon":0.02}',
        '{"type":"position","ts":"2030-03-28T09:00:00","vehicleRef":"M02","lat":200,"lon":0.02}',
        '{"type":"status","ts":"2030-03-28T09:01:00","vehicleRef":"M02","status":"FLYING"}',
        '{"type":"weather","ts":"2030-03-28T09:01:00"}',
        'not json',
        '{"type":"status","ts":"2030-03-28T09:02:00","vehicleRef":"M02","status":"DEPARTED","location":"DC"}',
      ].join('\n'),
      refs,
    );
    expect(r.items).toHaveLength(2);
    expect(r.rejected.map((x) => x.reason)).toEqual(['不认识的车辆编号', '时间格式不对', '坐标不对', '不认识的状态', '不认识的记录类型', '不是合法的 JSON']);
  });
  it('仓储和门店', () => {
    const r = parseWms(['ts,event,site,door,vehicle_ref,done,total,family,units', '2030-03-28T09:00:00,DOOR_OPEN,DC,C05,M02,,,,', '2030-03-28T09:00:00,DOOR_OPEN,DC,X99,M02,,,,', '2030-03-28T09:05:00,LOAD_SCAN,DC,C05,M02,30,24,,', '2030-03-28T09:05:00,SALES,S01,,,,,NOT_A_FAMILY,5', 'bad,row', '2030-03-28T09:10:00,STOCK_COUNT,S01,,,,,DAIRY,1200'].join('\n'), refs);
    expect(r.items.map((x) => x.m.kind)).toEqual(['door', 'stock']);
    expect(r.rejected.map((x) => x.reason)).toEqual(['缺少门号或门号不对', '装车进度的数值不对', '缺少商品族或商品族不对', '列数不对']);
  });
  it('港口 EDI：段数不符、箱号校验位不对、不支持的报文、文件不完整', () => {
    const good = ediFromEvents([{ t: 36000, code: 'RELEASED', container: containerId(1), sizeType: '45G1', full: true, location: 'PORT' }]);
    const badCount = good.replace(/UNT\+\d+/, 'UNT+99');
    const badBox = good.replace(containerId(1), `${containerId(1).slice(0, 10)}${(Number(containerId(1)[10]) + 1) % 10}`);
    const other = good.replace('IFTSTA:D:95B:UN', 'BAPLIE:D:95B:UN');
    const cut = good.slice(0, good.indexOf('UNT'));
    expect(parseEdi(good, refs).items).toHaveLength(1);
    expect(parseEdi(badCount, refs).rejected[0]?.reason).toBe('段数和 UNT 写的不符');
    expect(parseEdi(badBox, refs).rejected[0]?.reason).toMatch(/箱号校验位不对/);
    expect(parseEdi(other, refs).rejected[0]?.reason).toMatch(/不支持的报文类型 BAPLIE/);
    expect(parseEdi(cut, refs).rejected[0]?.reason).toMatch(/缺少 UNT/);
  });
});

describe('外部系统的数据驱动孪生（feed 模式）', () => {
  it('同一天的数据从运输管理、仓储和门店、港口三个接口进来：孪生出的建议卡和模拟的现场一样', () => {
    const r: Run = { level: 'rough', policy: 'auto', day: 87, seed: 4 };
    const a = live(r);
    const w = world(87);
    const refs = new Refs(w.board.ops, w.trace.vehicles);
    const rec = readRecording(a.text);
    const msgs = allMsgs(a.loop);
    const tms = [...rec.vehicles.filter((x) => !x.replan).map((x) => JSON.stringify(tmsTrip(x, refs))), ...tmsFromMsgs(msgs.filter((m) => ['gps', 'event', 'temp', 'soc', 'traffic'].includes(m.kind)), refs).map((x) => JSON.stringify(x))].join('\n');
    const wms = wmsFromMsgs(msgs, refs);
    const edi = ediFromEvents(portEventsFromPlan(w.board));
    const feed = loadFeed(
      [
        { name: 'tms.jsonl', text: tms },
        { name: 'wms.csv', text: wms },
        { name: 'port.edi', text: edi },
      ],
      new Refs(w.board.ops, w.trace.vehicles),
    );
    expect(feed.files.map((f) => [f.adapter, f.rejected])).toEqual([
      ['tms', 0],
      ['wms', 0],
      ['edi', 0],
    ]);
    const b = observed(r, { items: feed.items, vehicles: feed.vehicles });
    expect(b.loop.cards().map((x) => x.key)).toEqual(a.loop.cards().map((x) => x.key));
    expect(b.loop.cmds.map((c) => c.kind)).toEqual(a.loop.cmds.map((c) => c.kind));
    // 「看到的现场」按数据推出来的累计结果和模拟的现场接近（迟到按门店收货口开门的时刻，超温按每 5 分钟的读数）
    expect(b.field.kpi.lateStops).toBe(a.loop.field.kpi.lateStops);
    expect(Math.abs(b.field.kpi.lateMin - a.loop.field.kpi.lateMin)).toBeLessThan(2);
    expect(Math.abs(b.field.kpi.hotMin - a.loop.field.kpi.hotMin)).toBeLessThanOrEqual(15);
  });
});

/** 一天的计划（方案 3、种子、第几天、负荷），和孪生服务、样例脚本建的一样 */
const chainWorlds = new Map<string, { trace: NonNullable<ReturnType<typeof runChain>['trace']>; board: ReturnType<typeof buildBoard>; direct: readonly string[] }>();
function chainWorld(seed: number, day: number, load: LoadLevel) {
  const key = `${seed}:${day}:${load}`;
  let w = chainWorlds.get(key);
  if (!w) {
    const s = withLoad(scenarioFor('g3', seed), load);
    s.traceDay = day;
    const trace = runChain(s).trace!;
    w = { trace, board: buildBoard(trace.ops, emptyDay(), { allocation: allocationHour(s), crossDock: s.dc.crossDock }), direct: s.flow.direct };
    chainWorlds.set(key, w);
  }
  return w;
}
type ChainWorld = ReturnType<typeof chainWorld>;
const loopOf = (w: ChainWorld, seed: number, level: FieldLevel, policy: Policy) =>
  new Loop({ vehicles: w.trace.vehicles, ops: w.board.ops, board: w.board, seed, store: { stock: w.trace.storeStock, demand: w.trace.storeDemand }, direct: w.direct, level }, { closed: true, policy, decisions: [] });
const SAMPLE_META = { gen: 'g3', seed: 4, level: 'rough', policy: 'auto', region: 'default', load: 'normal', day: 87 };
const sampleFiles = () =>
  readdirSync(SAMPLES)
    .filter((n) => adapterOf(n))
    .sort()
    .map((n) => ({ name: n, text: readFileSync(join(SAMPLES, n), 'utf8') }));
type StatRow = { name: string; accepted: number; rejected: number; late: number; outOfOrder: number; stale: number; latency: { max: number } };
const statsOf = (s: DataSource) => s.adapters(String).adapters as StatRow[];

describe('实时接入（live、watch）', () => {
  const sw = chainWorld(4, 87, 'normal');

  /** 孪生服务的走法：孪生不跑到数据前面（不够就让推数据的一方再推一批）；数据推完了（这一天的数据齐了）照常走完 */
  function runLive(src: DataSource, loop: Loop, push: () => boolean, after?: (t: number) => void): void {
    while (!loop.done) {
      while (!src.ready(loop.t + 60) && push());
      loop.step();
      src.afterStep();
      after?.(loop.t);
    }
  }

  it('样例数据按时刻一批批推进来：孪生出的建议卡、发的指令、看到的现场、本店的箱和 feed 模式完全一样', () => {
    const feedLoop = loopOf(sw, 4, 'rough', 'auto');
    const refsA = new Refs(sw.board.ops, sw.trace.vehicles);
    const a = new DataSource({ spec: { mode: 'feed', dir: SAMPLES }, loop: feedLoop, board: sw.board, refs: refsA, feed: loadFeedDir(SAMPLES, refsA), meta: SAMPLE_META });
    a.start();
    while (!feedLoop.done) {
      feedLoop.step();
      a.afterStep();
    }

    const liveLoop = loopOf(sw, 4, 'rough', 'auto');
    const b = new DataSource({ spec: { mode: 'live' }, loop: liveLoop, board: sw.board, refs: new Refs(sw.board.ops, sw.trace.vehicles), meta: SAMPLE_META });
    b.start();
    expect(b.ready(60)).toBe(false);
    const recs = splitRecords(sampleFiles());
    let i = 0;
    let posts = 0;
    let at5: ReturnType<DataSource['containers']> = [];
    // 推数据的一方每次推 10 分钟的数据（切成不超过 60 秒的段、每段按接口分开推，运输管理在前）
    runLive(
      b,
      liveLoop,
      () => {
        if (i >= recs.length) return false;
        const until = (recs[i] as SendRecord).t + 600;
        const batch: SendRecord[] = [];
        while (i < recs.length && (recs[i] as SendRecord).t <= until) batch.push(recs[i++] as SendRecord);
        for (const x of postsOf(batch, 60)) {
          expect(b.ingest(x.adapter, x.text).rejected).toBe(0);
          posts++;
        }
        return true;
      },
      (t) => {
        if (t === 5 * 3600) at5 = b.containers();
      },
    );
    expect(posts).toBeGreaterThan(100);
    // 分开推的几次：后推的里最早的数据不比先推过的最晚的早 60 秒以上（孪生在两次之间往前走也走不过还没推的数据）
    const all = postsOf(recs, 60);
    expect(all.reduce((n, x) => n + x.n, 0)).toBe(recs.length);
    expect(all.length).toBeLessThan(recs.length / 2);
    let reach = -Infinity;
    for (const x of all) {
      expect(x.t0).toBeGreaterThanOrEqual(reach - 60);
      reach = Math.max(reach, x.t1);
    }
    expect(cardsOf(liveLoop)).toEqual(cardsOf(feedLoop));
    expect(cardsOf(liveLoop).length).toBeGreaterThan(0);
    expect(JSON.stringify(liveLoop.cmds)).toBe(JSON.stringify(feedLoop.cmds));
    expect(liveLoop.field.msgs.length).toBe(feedLoop.field.msgs.length);
    expect(liveLoop.field.kpi).toEqual(feedLoop.field.kpi);
    // 每个接口收的条数和 feed 模式一样，没有晚到、顺序乱、过时的
    const brief = (s: DataSource) => statsOf(s).map((x) => [x.name, x.accepted, x.rejected, x.late, x.outOfOrder, x.stale]);
    expect(brief(b)).toEqual(brief(a));
    expect(statsOf(b).every((x) => x.late === 0 && x.outOfOrder === 0 && x.stale === 0)).toBe(true);
    // 本店的箱：05:00 一个卸了船在等海关、一个已放行；一天下来三个都放行了
    expect(at5.map((x) => [x.id, x.state, x.customs])).toEqual([
      ['SXCU0860031', 'discharged', 'pending'],
      ['SXCU0860026', 'released', 'released'],
    ]);
    expect(b.containers().map((x) => [x.id, x.state])).toEqual([
      ['SXCU0860047', 'released'],
      ['SXCU0860031', 'released'],
      ['SXCU0860026', 'released'],
    ]);
    expect(b.containers()).toEqual(a.containers());
  });

  it('晚到、顺序乱的数据按发生的时刻补记，过时的定位不用，晚到的门磁不改收货口现在被谁占着；各自计数', () => {
    const r: Run = { level: 'normal', policy: 'manual' };
    const w = world(86);
    const loop = new Loop(input(r), { closed: true, policy: 'manual', decisions: [] });
    const refs = new Refs(w.board.ops, w.trace.vehicles);
    const src = new DataSource({ spec: { mode: 'live' }, loop, board: w.board, refs, meta: meta(r) });
    src.start();
    const op = w.board.ops.find((o) => o.vehicle >= 0 && (o.stops ?? []).some((x) => x.key === 'S01')) as (typeof w.board.ops)[number];
    const vid = op.vehicle;
    const ref = refs.ref(vid);
    const step = () => {
      loop.step();
      src.afterStep();
    };
    while (loop.t < 9 * 3600) step();
    const pos = (hm: string) => JSON.stringify({ type: 'position', ts: `2030-03-28T${hm}:00`, vehicleRef: ref, lat: 0.01, lon: 0.02 });
    const mine = () => loop.field.msgs.filter((m) => 'vid' in m && m.vid === vid).map((m) => `${m.kind}@${m.t}`);
    // 09:00 收到一批顺序乱的：09:03、09:02、08:58 的定位，08:48 到店；还有 08:50 开收货口
    expect(src.ingest('tms', [pos('09:03'), pos('09:02'), pos('08:58'), JSON.stringify({ type: 'status', ts: '2030-03-28T08:48:00', vehicleRef: ref, status: 'ARRIVED', location: 'S01' })].join('\n')).accepted).toBe(4);
    expect(src.ingest('wms', `${WMS_HEADER}\n2030-03-28T08:50:00,DOOR_OPEN,S01,S01-1,${ref},,,,\n`).queued).toBe(5);
    expect(src.ready(loop.t + 60)).toBe(true);
    step();
    // 晚到的按自己的时刻排好补记
    expect(mine()).toEqual(['event@31680', 'door@31800', 'gps@32280']);
    const field = loop.field as unknown as ObservedField;
    expect(field.storeDocks.get('S01-1')).toBe(vid);
    expect(field.stopResults[field.stopResults.length - 1]).toMatchObject({ vid, store: 'S01', t: 31800 });
    // 比开门还旧的关门（晚到的）不让收货口空出来
    src.ingest('wms', `${WMS_HEADER}\n2030-03-28T08:40:00,DOOR_CLOSE,S01,S01-1,${ref},,,,\n`);
    step();
    expect(field.storeDocks.get('S01-1')).toBe(vid);
    step();
    // 晚到的关门本身照样按它的时刻记进数据流
    expect(mine().slice(3)).toEqual(['door@31200', 'gps@32520', 'gps@32580']);
    // 孪生走过 09:03 以后才到的 09:01 的定位：比已经用上的旧，不用
    src.ingest('tms', pos('09:01'));
    expect(src.ready(loop.t + 60)).toBe(false);
    step();
    expect(mine()).toHaveLength(6);
    const st = statsOf(src);
    expect(st.find((x) => x.name === 'tms')).toMatchObject({ accepted: 5, rejected: 0, late: 3, outOfOrder: 4, stale: 1 });
    expect(st.find((x) => x.name === 'wms')).toMatchObject({ accepted: 2, late: 2, outOfOrder: 1, stale: 0 });
    // 延迟 = 孪生收到的时刻 − 数据的时刻：08:40 的关门 09:02 才交给孪生
    expect(st.find((x) => x.name === 'wms')?.latency.max).toBe(1320);
    // 时刻不在孪生这一天的不收
    const bad = src.ingest('tms', pos('09:05').replace('2030-03-28', '2030-04-02'));
    expect([bad.accepted, bad.reasons[0]?.reason]).toEqual([0, '时刻不在孪生的这一天（当天 0 点到第二天 2 点，最早收前一天 18 点的）']);
  });

  it('密钥和数据来源：HTTP 推送要带对请求头，WebSocket 的 ingest 消息要带对 token；数据来源不是 live、watch 的不收', async () => {
    const got: string[] = [];
    const host = (accepting: boolean, token?: string): IngestHost => ({
      accepting,
      mode: accepting ? 'live' : 'sim',
      token,
      ingest: (a) => {
        got.push(a);
        return { adapter: a, accepted: 1, rejected: 0, reasons: [], queued: 0 };
      },
    });
    let h = host(true, 's3cret-token');
    const server = createServer((req, res) => {
      void handleIngest(req, (req.url ?? '').replace('/api/ingest/', ''), h).then((r) => {
        res.writeHead(r.code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const post = async (path: string, headers: Record<string, string> = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: '{"type":"position"}\n' });
      return { code: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
    };
    try {
      expect((await post('/api/ingest/tms')).code).toBe(401);
      expect((await post('/api/ingest/tms', { 'x-ingest-token': 's3cret-tokeN' })).code).toBe(401);
      expect((await post('/api/ingest/tms', { 'x-ingest-token': 's3cret-token' })).code).toBe(200);
      expect((await post('/api/ingest/wms', { authorization: 'Bearer s3cret-token' })).code).toBe(200);
      expect((await post('/api/ingest/kafka', { 'x-ingest-token': 's3cret-token' })).code).toBe(404);
      h = host(false, 's3cret-token');
      const no = await post('/api/ingest/tms', { 'x-ingest-token': 's3cret-token' });
      expect([no.code, no.body.error]).toEqual([409, '数据来源是 sim：实时接入要用 --source live（或 live:<meta.json>）、--source watch:<目录> 启动孪生服务']);
      // 没设密钥：都收（服务默认只听本机）
      h = host(true);
      expect((await post('/api/ingest/edi')).code).toBe(200);
    } finally {
      server.close();
    }
    expect(got).toEqual(['tms', 'wms', 'edi']);
    const ws = host(true, 's3cret-token');
    expect(ingestMessage({ type: 'ingest', adapter: 'tms', data: '' }, false, ws)).toMatchObject({ ok: false });
    expect(ingestMessage({ type: 'ingest', adapter: 'tms', data: [{ type: 'position' }], token: 's3cret-token' }, false, ws)).toMatchObject({ ok: true, accepted: 1 });
    expect(ingestMessage({ type: 'ingest', adapter: 'wms', data: 'ts,event' }, true, ws)).toMatchObject({ ok: true });
    expect(ingestMessage({ type: 'ingest', adapter: 'edi', data: [] }, true, ws)).toMatchObject({ ok: false, error: '港口 EDI 要发 EDIFACT 文本' });
    expect([tokenOk('ab', 'abc'), tokenOk(undefined, 'abc'), tokenOk('x', undefined)]).toEqual([false, false, true]);
  });

  it('本店的箱：港口 EDI 的事件倒着到、再重发一遍，按发生的时刻排回去，状态和按顺序到的一样', () => {
    const refs = new Refs(sw.board.ops, sw.trace.vehicles);
    const items = parseEdi(readFileSync(join(SAMPLES, 'port.edi'), 'utf8'), refs).items;
    const inOrder = new ContainerBook();
    for (const x of items) inOrder.observe(x.m);
    const messy = new ContainerBook();
    for (const x of [...items].reverse()) messy.observe(x.m);
    for (const x of items) messy.observe(x.m);
    expect(messy.rows()).toEqual(inOrder.rows());
    const box = messy.rows().find((b) => b.id === 'SXCU0860031');
    expect(box?.events.map((e) => [e.code, e.note])).toEqual([
      ['DISCHARGE', '卸船'],
      ['RELEASED', '海关放行'],
    ]);
    expect(box?.vid).toBe(refs.vid('VS1'));
    // 海关查验以后放行；装上拖车出闸
    const id = containerId(424242);
    const book = new ContainerBook();
    const ev = (t: number, note: string, v = -1): Msg => ({ kind: 'event', t, vid: v, ev: 'done', place: 'PORT', note: `${note} ${id}` });
    book.observe(ev(100, '卸船', 5));
    book.observe(ev(300, '海关查验'));
    expect(book.rows()[0]).toMatchObject({ state: 'hold', label: '海关查验中', customs: 'hold', since: 300 });
    book.observe(ev(900, '出闸', 7));
    book.observe(ev(600, '海关放行'));
    expect(book.rows()[0]).toMatchObject({ state: 'gateOut', customs: 'released', vid: 7, since: 900 });
    expect(book.observe({ kind: 'event', t: 1, vid: 1, ev: 'done', note: '货已转到救援车' })).toBe(false);
  });

  it('盯着目录：新文件从头读，追加的部分只交完整的行和报文（接着读的补上表头、服务字符串）；数据来源 watch 把它们交给孪生', () => {
    const dir = mkdtempSync(join(tmpdir(), 'storex-watch-'));
    try {
      const tail = new DirTail(dir);
      writeFileSync(join(dir, 'tms.jsonl'), '{"a":1}\n{"b":');
      writeFileSync(join(dir, 'wms.csv'), `${WMS_HEADER}\n2030-03-28T09:00:00,DOOR_OPEN,DC,C05,M02,,,,\n`);
      writeFileSync(join(dir, 'notes.txt'), '不是数据');
      expect(tail.poll()).toEqual([
        { name: 'tms.jsonl', adapter: 'tms', text: '{"a":1}\n' },
        { name: 'wms.csv', adapter: 'wms', text: `${WMS_HEADER}\n2030-03-28T09:00:00,DOOR_OPEN,DC,C05,M02,,,,\n` },
      ]);
      expect(tail.poll()).toEqual([]);
      appendFileSync(join(dir, 'tms.jsonl'), '2}\n');
      appendFileSync(join(dir, 'wms.csv'), '2030-03-28T09:05:00,DOOR_CLOSE,DC,C05,M02,,,,\n');
      expect(tail.poll()).toEqual([
        { name: 'tms.jsonl', adapter: 'tms', text: '{"b":2}\n' },
        { name: 'wms.csv', adapter: 'wms', text: `${WMS_HEADER}\n2030-03-28T09:05:00,DOOR_CLOSE,DC,C05,M02,,,,\n` },
      ]);
      // EDIFACT：写了一半的报文等写完
      const refs = new Refs(board.ops, trace.vehicles);
      const edi = ediFromEvents([
        { t: 36000, code: 'DISCHARGE', container: containerId(1), sizeType: '45G1', full: true, location: 'PORT' },
        { t: 39600, code: 'RELEASED', container: containerId(1), sizeType: '45G1', full: true, location: 'PORT' },
      ]);
      const cut = edi.indexOf('UNH+2') + 12;
      writeFileSync(join(dir, 'port.edi'), edi.slice(0, cut));
      const first = tail.poll();
      expect(first.map((x) => x.name)).toEqual(['port.edi']);
      expect(parseEdi((first[0] as { text: string }).text, refs)).toMatchObject({ rejected: [], events: [{ code: 'DISCHARGE' }] });
      appendFileSync(join(dir, 'port.edi'), edi.slice(cut));
      const second = tail.poll();
      expect((second[0] as { text: string }).text.startsWith("UNA:+.? '")).toBe(true);
      expect(parseEdi((second[0] as { text: string }).text, refs)).toMatchObject({ rejected: [], events: [{ code: 'RELEASED' }] });
      expect(tail.list().find((f) => f.name === 'port.edi')).toMatchObject({ chunks: 2, bytes: Buffer.byteLength(edi.trimEnd()) });

      // 数据来源 watch：启动时读已有的文件，之后追加的每次 poll 读进来
      const wdir = mkdtempSync(join(tmpdir(), 'storex-watch-'));
      try {
        const wms = readFileSync(join(SAMPLES, 'wms.csv'), 'utf8');
        const half = wms.indexOf('\n', wms.length >> 1) + 1;
        writeFileSync(join(wdir, 'wms.csv'), wms.slice(0, half + 20));
        const loop = loopOf(sw, 4, 'rough', 'auto');
        const src = new DataSource({ spec: { mode: 'watch', dir: wdir }, loop, board: sw.board, refs: new Refs(sw.board.ops, sw.trace.vehicles), meta: SAMPLE_META });
        src.start();
        const n0 = statsOf(src).find((x) => x.name === 'wms')?.accepted ?? 0;
        appendFileSync(join(wdir, 'wms.csv'), wms.slice(half + 20));
        src.poll();
        // 只有仓储系统的文件：追加补货车（运输管理登记的新车）的门磁不认识，照样拒掉并记下原因
        const whole = parseWms(wms, new Refs(sw.board.ops, sw.trace.vehicles));
        const all = whole.items.length;
        expect(n0).toBe(parseWms(wms.slice(0, half), new Refs(sw.board.ops, sw.trace.vehicles)).items.length);
        expect(statsOf(src).find((x) => x.name === 'wms')).toMatchObject({ accepted: all, rejected: whole.rejected.length });
        expect((src.info().files as { name: string; accepted: number }[]).map((f) => [f.name, f.accepted])).toEqual([['wms.csv', all]]);
        expect(src.ready(12 * 3600)).toBe(true);
      } finally {
        rmSync(wdir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('等月台门、等收货口按门磁推出来：和模拟的现场每辆车差 1 分钟以内', () => {
    const compare = (seed: number, day: number, load: LoadLevel) => {
      const w = chainWorld(seed, day, load);
      const sim = loopOf(w, seed, 'rough', 'manual');
      const lines: string[] = [];
      const rec = new Recorder((l) => lines.push(l));
      rec.attach(sim, { gen: 'g3', seed, level: 'rough', policy: 'manual', region: 'default', load, day });
      while (!sim.done) {
        sim.step();
        rec.check(sim);
      }
      const r = readRecording(lines.join('\n'));
      const ob = loopOf(w, seed, 'rough', 'manual');
      const field = new ObservedField(ob.field, { steps: r.steps, vehicles: r.vehicles }, w.board, (c) => costOf(ob, c), new Map([['replay', new AdapterStats('replay')]]));
      swapField(ob, field);
      while (!ob.done) {
        ob.step();
        field.sync(ob.t);
      }
      return { sim: sim.field, seen: field };
    };
    const near = (a: Map<number, number>, b: Map<number, number>) => {
      expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
      for (const [vid, min] of a) expect(Math.abs((b.get(vid) ?? 0) - min)).toBeLessThanOrEqual(1.01);
    };
    // 负荷高的一天：同一樘冷链门前后排着 5 辆车
    const doors = compare(4, 86, 'high');
    expect(doors.sim.by.door.size).toBe(5);
    near(doors.sim.by.door, doors.seen.by.door);
    expect(Math.abs(doors.seen.kpi.doorWaitMin - doors.sim.kpi.doorWaitMin)).toBeLessThanOrEqual(5.05);
    // 门店只有 1 个收货口：后到的车在收货场排队
    const keep = STORE.docks;
    STORE.docks = 1;
    try {
      for (const [seed, day, load] of [
        [1, 86, 'normal'],
        [4, 87, 'normal'],
      ] as const) {
        const docks = compare(seed, day, load);
        expect(docks.sim.by.dock.size).toBeGreaterThanOrEqual(2);
        near(docks.sim.by.dock, docks.seen.by.dock);
      }
    } finally {
      STORE.docks = keep;
    }
  });

  it('值班助手的港口回答带上本店的箱（孪生服务接了港口 EDI 时）', () => {
    const ctx = { t: 10 * 3600, board: sw.board, rows: [], containers: () => [
      { id: 'SXCU0860031', state: '海关已放行，等装车提走', since: 30968, vehicle: 'VS1' },
      { id: 'SXCU0860047', state: '已卸船，等海关放行', since: 28568, vehicle: 'VS1' },
    ] };
    const a = new Assistant().ask('港口怎么样', ctx);
    expect(a.tools.map((x) => x.name)).toContain('get_facility');
    expect(a.text).toContain('本店的箱（港口 EDI）：2 个——海关已放行，等装车提走 1 个；已卸船，等海关放行 1 个。最近一次是 08:36 SXCU0860031（VS1）：海关已放行，等装车提走。');
    expect(a.cites.join('、')).toContain('港口 EDI');
    // 没接港口 EDI（模拟的现场、网页）就没有这一行
    expect(new Assistant().ask('港口怎么样', { ...ctx, containers: () => [] }).text).not.toContain('本店的箱');
  });

  it('仓储和门店的数据也可以是 JSON（数组或一行一个对象）：和 CSV 转出来的一样，坏的说清楚', () => {
    const refs = new Refs(board.ops, trace.vehicles);
    const csv = [WMS_HEADER, '2030-03-28T09:00:00,DOOR_OPEN,DC,C05,M02,,,,', '2030-03-28T09:05:00,LOAD_SCAN,DC,C05,M02,6,24,,', '2030-03-28T09:10:00,STOCK_COUNT,S01,,,,,DAIRY,1200'].join('\n');
    const rows = [
      { ts: '2030-03-28T09:00:00', event: 'DOOR_OPEN', site: 'DC', door: 'C05', vehicleRef: 'M02' },
      { ts: '2030-03-28T09:05:00', event: 'LOAD_SCAN', site: 'DC', door: 'C05', vehicle_ref: 'M02', done: 6, total: 24 },
      { ts: '2030-03-28T09:10:00', event: 'STOCK_COUNT', site: 'S01', family: 'DAIRY', units: 1200 },
    ];
    const want = parseWms(csv, refs).items;
    expect(want).toHaveLength(3);
    expect(parseWms(JSON.stringify(rows), refs).items).toEqual(want);
    expect(parseWms(rows.map((x) => JSON.stringify(x)).join('\n'), refs).items).toEqual(want);
    expect(parseWms('[1, {"ts":"9点"}]', refs).rejected.map((x) => x.reason)).toEqual(['不是一条记录', '时间格式不对']);
    expect(parseWms('[{"ts":', refs).rejected.map((x) => x.reason)).toEqual(['不是合法的 JSON']);
  });
});
