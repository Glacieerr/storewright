import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Assistant, handover, reportShift, review, SHIFTS, TOOLS, watchList } from '../src/assistant';
import { fromTrack, twinSnap } from '../src/assistant/context';
import type { AssistCtx, Proposal, VehRow } from '../src/assistant/types';
import { ROLES, type Role } from '../src/assistant/roles';
import { ownFromOps, planPortHub } from '../src/hub/port';
import { estimateAirDay } from '../src/hub/airportEstimate';
import { placeResolver } from '../src/hub/doors';
import { planPark } from '../src/hub/park';
import { storeDay, type StoreDay } from '../src/hub/storeDay';
import { currentFacilities } from '../src/facility/state';
import { jobFromBoard } from '../src/site/trucks';
import { runDay } from '../../StoreX/src/ops/day';
import { gen1, storex } from '../../StoreX/src/world/config';
import { decorVehicles } from '../web/src/decor';
import { RoadNet } from '../web/src/three/roadnet';
import { dockXs } from '../web/src/three/stores';
import type { HubDay } from '../src/hub/types';
import { LIMIT } from '../src/twin/models';
import { evaluate } from '../src/assistant/kpiBoard';
import { askWithLlm, createProvider, llmConfig, type LlmProvider } from '../src/assistant/llm';
import { kpi as kpiOf } from '../src/analysis/kpi';
import refData from '../web/src/data/results.json';
import { regionSpecFrom, regionSpecText } from '../src/region/regionGen';
import { setRegion, STORE } from '../src/region/network';
import { FAMILIES } from '../src/region/products';
import { DIORAMA_SCALE, NODES, type Km } from '../src/region/region';
import { buildBoard, DOORS } from '../src/sim/board';
import { LOADS, scenarioFor, withLoad, type Gen, type LoadLevel } from '../src/sim/config';
import { runChain } from '../src/sim/engine';
import { allocationHour, emptyDay } from '../src/sim/plan';
import { posAt } from '../src/twin/track';
import { type FieldLevel } from '../src/twin/field';
import { Loop } from '../src/twin/loop';
import { clock } from '../src/twin/twin';
import type { Cmd, Policy, Rec } from '../src/twin/types';
import { dcDoorsWorld, registerPlaces } from '../web/src/three/places';
import { trackRow, type TrackCtx } from '../web/src/tracking';
import { GEO, parseGeo, Refs, registerExtras, type GeoOrigin } from './adapters/common';
import { handleIngest, ingestMessage, tokenOf, tokenOk, type IngestHost } from './adapters/live';
import { DataSource, feedMeta, loadFeedDir, loadRecording, parseSource, readMeta } from './adapters/source';
import { Poses, type Pose } from './poses';
import { acceptWs, type WsClient } from './ws';

/**
 * 孪生服务：在服务器上跑全链路仿真（得到当天的计划）、调度台（排好门和车）和闭环孪生（现场 + 孪生），
 * 按（可以加速的）真实时间一分钟一分钟往前走，把现场的车辆位置、感知数据、孪生的建议推给外部系统：
 * 虚幻引擎（server/protocol.md 有坐标换算）、MATLAB（REST）、浏览器。外部系统可以批准 / 否决建议、直接发指令。
 *
 *   npx tsx server/twinServer.ts --port 8787 --gen g3 --seed 1 --level normal --policy safe --speed 10 --start 4 --region default --load normal
 *
 * speed = 每秒走几分钟（10 = 一天 2.4 小时走完）；start = 从当天几点开始；region = 区域（default、random-编号或自定义的写法，和网页地址里的 ?region= 一样）；
 * load = 负荷档位（normal / peak / high / extreme）。设施用默认配置。
 *
 * 对接真实系统（server/adapters/）：--source sim（默认，服务里模拟的现场）/ replay:<记录文件> / feed:<外部系统文件的目录>
 * / live（或 live:<meta.json>：外部系统实时推数据，POST /api/ingest/tms|wms|edi、WebSocket 的 ingest）/ watch:<目录>（盯着目录读新文件和追加的部分）；
 * live、watch 时孪生按收到的数据的时刻走（不跑到数据前面，--lateness 秒允许数据晚到，默认 60），默认从 0 点开始；
 * --ingest-token <密钥>（或环境变量 STOREX_INGEST_TOKEN）：推数据要带的密钥，服务不只听本机时至少要设；
 * --record <文件> 把孪生收到的数据记下来（.gz 结尾的压缩）；--outbox <文件> 把孪生的指令换算成外部系统的指令写出去；
 * --geo-origin 纬度,经度 换经纬度和沙盘坐标的原点。回放和外部系统的数据带着它对应的计划（方案、种子、区域……），命令行没指定的按它。
 *
 * 安全（见 server/protocol.md「安全」）：默认只听本机 127.0.0.1；--token <密钥>（或环境变量 STOREX_TOKEN）设了以后，改状态的接口
 * （批准、否决、指令、控制）和 WebSocket 指令都要带密钥；--host 不是本机又没设密钥时拒绝启动（确实要开放再加 --insecure，会警告）；
 * 默认不回跨域头，--allow-origin a,b 列出允许的浏览器来源，别的浏览器来源改状态、连 WebSocket 一律拒绝；请求体上限 64 KB。
 */
const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);
// —— 数据从哪来：模拟的现场、一份记录、外部系统的文件 ——
const SOURCE = parseSource(arg('source', 'sim'));
if ('error' in SOURCE) {
  process.stderr.write(`${SOURCE.error}\n`);
  process.exit(1);
}
const RECORDING = SOURCE.mode === 'replay' ? loadRecording(SOURCE.file) : undefined;
const META: Record<string, unknown> =
  (RECORDING?.meta as unknown as Record<string, unknown> | undefined) ?? (SOURCE.mode === 'feed' || SOURCE.mode === 'watch' ? feedMeta(SOURCE.dir) : SOURCE.mode === 'live' && SOURCE.meta ? readMeta(SOURCE.meta) : undefined) ?? {};
/** 外部系统实时推数据（live）或盯着目录（watch）：收 /api/ingest，孪生不跑到数据前面 */
const LIVE = SOURCE.mode === 'live' || SOURCE.mode === 'watch';
/** 访问密钥：设了以后改状态的接口和 WebSocket 指令都要带（请求头 Authorization: Bearer <密钥> 或 x-ingest-token；WebSocket 也可以在网址里 ?token=、每条消息里 token） */
const TOKEN = has('token') ? arg('token', '') || undefined : process.env.STOREX_TOKEN || undefined;
/** 实时接入的密钥：没单独设就用访问密钥 */
const INGEST_TOKEN = (has('ingest-token') ? arg('ingest-token', '') || undefined : process.env.STOREX_INGEST_TOKEN || undefined) ?? TOKEN;
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
/** 允许的浏览器来源（--allow-origin，逗号分开）：只有这些来源回跨域头、能改状态、能连 WebSocket；服务自己的地址也算 */
const ALLOW_ORIGINS = new Set(arg('allow-origin', '').split(',').map((x) => x.trim()).filter(Boolean));
const MAX_BODY = 64 * 1024;
const LATENESS = ((x) => (Number.isFinite(x) ? Math.max(0, x) : 60))(Number(arg('lateness', '60')));
/** 命令行指定的优先，其次是记录 / 外部数据带的计划，最后是默认值 */
const pick = (name: string, def: string): string => (has(name) ? arg(name, def) : META[name] !== undefined ? String(META[name]) : def);
const GEO_ORIGIN: GeoOrigin = parseGeo(arg('geo-origin', '')) ?? (META.geoOrigin as GeoOrigin | undefined) ?? GEO;
const PORT = Number(arg('port', '8787'));
const HOST = arg('host', '127.0.0.1');
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  process.stderr.write(`--port 要是 0–65535 的整数，现在是「${arg('port', '8787')}」\n`);
  process.exit(1);
}
// 不只听本机又没有访问密钥：拒绝启动（确实要开放加 --insecure，会警告）
if (!LOOPBACK.includes(HOST) && !TOKEN) {
  if (!has('insecure')) {
    process.stderr.write(`拒绝启动：服务要听 ${HOST}（不只本机），但没有设访问密钥。加 --token <一长串随机字符>（或环境变量 STOREX_TOKEN）；确实要在没有密钥的情况下对外开放，再加 --insecure。\n`);
    process.exit(1);
  }
  process.stderr.write(`警告：用了 --insecure，服务听 ${HOST} 又没有访问密钥，能连上这台机器的谁都能批准建议卡、下指令、改速度。只在可信的网络里这样用。\n`);
}
const GEN = pick('gen', 'g3') as Gen;
const SEED = Number(pick('seed', '1'));
const LEVEL = pick('level', 'normal') as FieldLevel;
const POLICY = pick('policy', 'safe') as Policy;
const REGION_SPEC = regionSpecFrom(pick('region', 'default'));
const LOAD: LoadLevel = pick('load', 'normal') in LOADS ? (pick('load', 'normal') as LoadLevel) : 'normal';
let speed = Number(arg('speed', '10'));
let paused = false;
const TRACE_DAY = Number.isInteger(META.day) ? (META.day as number) : 86;

// —— 当天的计划和闭环 ——
setRegion(REGION_SPEC);
const s = withLoad(scenarioFor(GEN, SEED), LOAD);
s.traceDay = TRACE_DAY;
const chain = runChain(s);
const trace = chain.trace;
if (!trace) throw new Error('仿真没有记录这一天');
const board = buildBoard(trace.ops, emptyDay(), { allocation: allocationHour(s), crossDock: s.dc.crossDock });
const loopInput = { vehicles: trace.vehicles, ops: board.ops, board, seed: SEED, store: { stock: trace.storeStock, demand: trace.storeDemand }, direct: [...s.flow.direct], level: LEVEL };
const loop = new Loop(loopInput, { closed: true, policy: POLICY, decisions: [] });
const poses = new Poses(board);
// 数据来自记录或外部系统时换掉模拟的现场；要记录的从 0 点开始记；指令换算成外部系统的指令放进发件箱
const refs = new Refs(board.ops, trace.vehicles);
const feed = SOURCE.mode === 'feed' ? loadFeedDir(SOURCE.dir, refs, GEO_ORIGIN) : undefined;
if (RECORDING) registerExtras(refs, RECORDING.vehicles);
const source = new DataSource({
  spec: SOURCE,
  loop,
  board,
  refs,
  ...(RECORDING ? { recording: RECORDING } : {}),
  ...(feed ? { feed } : {}),
  ...(has('record') ? { recordPath: arg('record', 'twin-record.jsonl') } : {}),
  ...(has('outbox') ? { outboxPath: arg('outbox', 'outbox.jsonl') } : {}),
  lateness: LATENESS,
  geo: GEO_ORIGIN,
  meta: { gen: GEN, seed: SEED, level: LEVEL, policy: POLICY, region: regionSpecText(REGION_SPEC), load: LOAD, day: TRACE_DAY },
});
source.start();
const stepLoop = (): void => {
  loop.step();
  source.afterStep();
};
// 实时接入默认从 0 点开始，跟着数据走（指定了 --start 的先快进到那里，之前的数据算晚到）
const start = Number(arg('start', LIVE ? '0' : '4')) * 3600;
while (loop.t < start) stepLoop();

const labelOf = (vid: number): string => board.ops.find((o) => o.vehicle === vid)?.id ?? loop.field.fv.find((f) => f.vid === vid)?.v.label.replace(/（.*$/, '') ?? `车 ${vid}`;

/**
 * 每辆车的详细信息（和网页「实时跟踪」同一套计算）：从哪来、到哪去、计划出发 / 到达、下一站和孪生估计的到达、载重、货物、停靠站。
 * 现场的车按它此刻对应的计划时刻 τ 取计划；预计到达 = 孪生按感知数据的估计（没有估计就按计划加上现在的延误）。
 */
const tctx: TrackCtx = {
  list: trace?.vehicles ?? [],
  tracked: () => true,
  opOf: (i) => board.ops.find((o) => o.vehicle === i),
  pose: () => undefined,
  roadAt: () => undefined,
};
interface Detail {
  from: string;
  to: string;
  depart?: number;
  arrive?: number;
  next: string;
  nextPlan?: number;
  eta?: number;
  load: string;
  kg?: number;
  cargo: string;
  stops: { name: string; plan: number; eta?: number; passed: boolean }[];
}
function detail(vid: number): Detail | undefined {
  const f = loop.field.fv.find((x) => x.vid === vid);
  const t = loop.t;
  const tau = f ? f.tau : t;
  if (!trace?.vehicles[vid]) return undefined;
  const row = trackRow(tctx, vid, tau);
  if (!row) return undefined;
  const delay = t - tau;
  const est = loop.twin.estimate(vid, t);
  const storeEta = est?.storeEta !== undefined && Number.isFinite(est.storeEta) ? est.storeEta : undefined;
  const toStore = row.next === STORE.name;
  // 去门店的那一站用孪生的估计（按感知数据，考虑路况和收货口），其余按定位算出的延误顺延
  const eta = row.nextPlan === undefined ? undefined : toStore && storeEta !== undefined ? storeEta : row.nextPlan + delay;
  const lastStop = row.stops[row.stops.length - 1];
  const r = (x: number) => Math.round(x);
  return {
    from: row.origin,
    to: row.dest,
    ...(row.depart !== undefined ? { depart: r(row.depart) } : {}),
    ...(lastStop ? { arrive: r(lastStop.plan) } : row.end !== undefined ? { arrive: r(row.end) } : {}),
    next: row.next,
    ...(row.nextPlan !== undefined ? { nextPlan: r(row.nextPlan) } : {}),
    ...(eta !== undefined ? { eta: r(eta) } : {}),
    load: row.load,
    ...(row.kg !== undefined ? { kg: r(row.kg) } : {}),
    cargo: row.cargo,
    stops: row.stops.map((x) => ({ name: x.name, plan: r(x.plan), ...(x.passed ? {} : { eta: r(x.plan + delay) }), passed: x.passed })),
  };
}

/** 此刻每辆车的位置（现场的车按计划时刻 τ 取车道级位置；火车、船、飞机按仿真的轨迹）和详细信息 */
function vehicles(): (Pose & { vid: number; id: string; kind: string; label: string; delayMin: number; temp?: number; state: string } & Partial<Omit<Detail, 'stops'>>)[] {
  const out: (Pose & { vid: number; id: string; kind: string; label: string; delayMin: number; temp?: number; state: string } & Partial<Omit<Detail, 'stops'>>)[] = [];
  const brief = (vid: number) => {
    const d = detail(vid);
    if (!d) return {};
    const { stops, ...rest } = d;
    void stops;
    return rest;
  };
  const t = loop.t;
  const fieldVids = new Set<number>();
  for (const f of loop.field.fv) {
    fieldVids.add(f.vid);
    if (!f.started || f.finished) continue;
    const p = poses.pose(f.vid, f.v, f.tau);
    if (!p) continue;
    const state = f.broken ? '抛锚' : f.heldBy !== undefined ? '等救援车' : f.waitingDoor ? '等月台门' : f.waitingDock ? '等收货口' : f.holdUntil !== undefined ? '按指令晚点到' : '';
    out.push({ ...p, vid: f.vid, id: labelOf(f.vid), kind: f.v.kind, label: f.v.label, delayMin: Math.round((t - f.tau) / 60), ...(f.reefer ? { temp: Math.round(f.reefer.st.product * 10) / 10 } : {}), state, ...brief(f.vid) });
  }
  trace?.vehicles.forEach((v, vid) => {
    if (fieldVids.has(vid)) return;
    const sg = v.segs.find((x) => t >= x.t0 && t < x.t1);
    if (!sg) return;
    const p = posAt(sg, t);
    const q = posAt(sg, Math.min(sg.t1 - 0.01, t + 30));
    const heading = Math.hypot(q.x - p.x, q.z - p.z) > 0.01 ? ((Math.atan2(q.z - p.z, q.x - p.x) * 180) / Math.PI + 360) % 360 : 0;
    out.push({ x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100, heading: Math.round(heading * 100) / 100, reversing: false, act: sg.act ?? '', vid, id: board.ops.find((o) => o.vehicle === vid)?.id ?? `${v.kind}-${vid}`, kind: v.kind, label: v.label, delayMin: 0, state: '', ...brief(vid) });
  });
  return out;
}

function state() {
  const k = loop.field.kpi;
  return {
    t: loop.t,
    clock: clock(loop.t),
    speed,
    paused,
    kpi: { lateMin: Math.round(k.lateMin), hotMin: Math.round(k.hotMin), shortMin: Math.round(k.shortMin), lostUnits: Math.round(k.lostUnits), doorWaitMin: Math.round(k.doorWaitMin), dockWaitMin: Math.round(k.dockWaitMin), cost: Math.round(k.cost) },
    vehicles: vehicles(),
    doors: Object.fromEntries([...loop.field.doors.entries(), ...loop.field.storeDocks.entries()].map(([d, vid]) => [d, labelOf(vid)])),
    store: Object.fromEntries(FAMILIES.map((f) => [f.key, { est: Math.round(loop.twin.stock.get(f.key)?.est ?? NaN), truth: Math.round(loop.field.stock.get(f.key) ?? NaN) }])),
    cards: loop.cards().filter((r) => r.status === 'proposed').length,
  };
}

const P = (k: Km) => ({ x: k.x * DIORAMA_SCALE, z: -k.y * DIORAMA_SCALE });
function model() {
  const site = [...poses.sites.values()][0];
  return {
    day: TRACE_DAY,
    source: source.info(),
    gen: GEN,
    seed: SEED,
    level: LEVEL,
    policy: POLICY,
    region: regionSpecText(REGION_SPEC),
    load: LOAD,
    coordinates: {
      units: '米（沙盘）：1 公里画成 100 米，建筑和车辆按真实尺寸',
      axes: 'x 向东、z 向南、y 向上（three.js 右手系）',
      unreal: 'X = x × 100、Y = z × 100、Z = y × 100（厘米，左手系、Z 向上）；Yaw = heading（度）',
    },
    store: site ? { key: STORE.key, name: STORE.name, center: { x: site.center.x, z: site.center.z }, rotation: site.rot, docks: site.docks.map((d, k) => ({ id: `${STORE.key}-${k + 1}`, x: d.door.x, z: d.door.z })) } : undefined,
    dc: { doors: dcDoorsWorld().filter((d) => DOORS.dry.includes(d.id) || DOORS.cold.includes(d.id)) },
    nodes: Object.entries(NODES).map(([id, k]) => ({ id, ...P(k) })),
    families: FAMILIES.map((f) => ({ key: f.key, label: f.label, temp: f.temp, source: f.source, direct: s.flow.direct.includes(f.key) })),
    vehicles: trace?.vehicles.map((v, vid) => ({ vid, kind: v.kind, label: v.label, op: board.ops.find((o) => o.vehicle === vid)?.id })),
  };
}

// —— 值班助手：和网页同一个助手，读的是服务里此刻的计划和闭环（没有设施监控那部分）——
const bot = new Assistant();
/** 资料库：设计文档（启动时读一次） */
const docs = [
  ['规划报告', '01-planning-report.md'],
  ['三代对比', '02-generation-comparison.md'],
  ['商业分析', '03-business-analysis.md'],
  ['系统设计', '04-system-design.md'],
].flatMap(([title, file]) => {
  try {
    return [{ title: title as string, text: readFileSync(new URL(`../docs/${file}`, import.meta.url), 'utf8') }];
  } catch {
    return [];
  }
});
function assistRows(): VehRow[] {
  const out: VehRow[] = [];
  for (const f of loop.field.fv) {
    if (!trace?.vehicles[f.vid]) continue;
    const row = trackRow(tctx, f.vid, f.tau);
    if (!row) continue;
    const d = detail(f.vid);
    const moving = f.started && !f.finished;
    out.push({ ...fromTrack(row), id: labelOf(f.vid), ...(moving ? { delayMin: Math.round((loop.t - f.tau) / 60) } : {}), ...(d?.eta !== undefined ? { nextEta: d.eta } : {}), ...(f.reefer && moving ? { temp: { value: Math.round(f.reefer.st.product * 10) / 10, limit: LIMIT[f.reefer.zone] } } : {}) });
  }
  return out;
}
/**
 * 仓储中心当天的作业计划（值班助手查仓储中心、找瓶颈、预约错峰用），和网页按同一套模型排：
 * - 港口物流中心：planPortHub；
 * - 物流园：planPark，车停哪个门按调度台的作业（src/hub/doors.ts，和网页同一份对应），月台门预约照调度台；
 * - 门店：先跑一天 StoreX 门店仿真（和网页的门店线程一样，约 1 秒），再排停车场、收货场（src/hub/storeDay.ts；停车场里的车流不排）；
 * - 机场货站：服务里没有三维的机坪排程，当天的航班和板的进出按 src/hub/airportEstimate.ts 估（估算，数和网页会差一点）。
 * 第一次问到时才算，算一次；哪个没排出来就少那一个（回答会说那个设施的计划没接上）。
 */
let hubMemo: { days: HubDay[]; store?: StoreDay } | undefined;
function hubPlans(): { days: HubDay[]; store?: StoreDay } {
  if (hubMemo) return hubMemo;
  const traffic = LOADS[LOAD].traffic;
  // 和网页一样：仿真的车加上点缀的车（货运班列等，物流园的铁路货运站要用）
  const own = trace?.vehicles ?? [];
  const list = [...own, ...decorVehicles(own.length)];
  const resolve = placeResolver(board.ops);
  const opByVid = new Map(board.ops.filter((o) => o.vehicle >= 0).map((o) => [o.vehicle, o] as const));
  const palletsOf = (vid: number) => opByVid.get(vid)?.pallets;
  const opOf = (vid: number) => opByVid.get(vid)?.id;
  const days: HubDay[] = [];
  let store: StoreDay | undefined;
  const add = (label: string, f: () => HubDay | undefined) => {
    try {
      const d = f();
      if (d) days.push(d);
    } catch (err) {
      process.stderr.write(`${label}的作业计划没排出来：${String(err)}\n`);
    }
  };
  add('港口物流中心', () => planPortHub({ seed: SEED, traffic, gen: GEN, own: ownFromOps(board.ops, s.port.dwellDays * 24) }).day);
  add('机场货站', () => estimateAirDay({ vehicles: list, seed: SEED, traffic, idOf: opOf }).hub);
  add('物流园', () => {
    const fac = currentFacilities().dc;
    const bookings = board.doors.flatMap((d) => d.bookings.filter((b) => /^[DC]\d\d$/.test(b.door)).map((b) => ({ door: b.door, t0: b.t0, t1: b.t1, mode: b.mode })));
    return planPark({ vehicles: list, doorOf: resolve, bookings, palletsOf, opOf, seed: SEED, traffic, tracks: fac.railTracks, open: { dry: fac.dryDoors, cold: fac.coldDoors } }).hub;
  });
  add('门店', () => {
    // 门店的停车场、收货场按区域的道路排（和网页同一份场地）
    const site = registerPlaces(new RoadNet()).get(STORE.key);
    if (!site) return undefined;
    const generation = GEN === 'g1' ? 'gen1' : 'storex';
    const sx = generation === 'gen1' ? gen1(SEED) : storex(SEED);
    sx.trace = true;
    const agents = runDay(sx).trace?.agents ?? [];
    store = storeDay({ agents, generation, seed: SEED, store: STORE.key, lot: site.lot, docks: dockXs(site.st.docks).length, ...(site.yard ? { yard: { key: site.yard.key, plan: site.yard.plan } } : {}), vehicles: list, resolve, palletsOf, jobOf: jobFromBoard(board.ops, STORE.key) });
    return store.hub;
  });
  return (hubMemo = { days, ...(store ? { store } : {}) });
}
const hubDays = (): HubDay[] => hubPlans().days;
/** 门店收货场的场地排程输入：预约错峰按它用场地排程器算 */
const hubYards = () => {
  const st = hubPlans().store;
  return st?.yard ? { store: st.yard } : {};
};

function assistCtx(): AssistCtx {
  return {
    hubs: hubDays,
    yards: hubYards,
    // 推演临时扰动（某趟车晚、某个门停用、封路、班轮晚）：和闭环孪生同一份现场输入
    sim: () => ({ input: loopInput }),
    t: loop.t,
    gen: GEN,
    board,
    day: emptyDay(),
    allocation: allocationHour(s),
    rows: assistRows(),
    twin: twinSnap(loop.result(), undefined, loop.t, POLICY, [], trace?.storeDemand ?? {}),
    docs,
    containers: () => source.containers().map((b) => ({ id: b.id, state: b.label, since: b.since, ...(b.vid !== undefined ? { vehicle: refs.ref(b.vid) } : {}) })),
  };
}

/** 本店的箱在港口的状态（港口 EDI 的事件）：每个箱现在怎样、从什么时候起、谁装卸的、经过的事件 */
const containersOut = () => {
  const rows = source.containers();
  const byState: Record<string, number> = {};
  for (const b of rows) byState[b.label] = (byState[b.label] ?? 0) + 1;
  return {
    t: loop.t,
    clock: clock(loop.t),
    source: SOURCE.mode,
    summary: { total: rows.length, byState },
    containers: rows.map((b) => ({ id: b.id, state: b.state, label: b.label, since: b.since, sinceClock: clock(b.since), customs: b.customs, ...(b.vid !== undefined ? { vehicle: refs.ref(b.vid) } : {}), events: b.events.map((e) => ({ t: e.t, clock: clock(e.t), code: e.code, note: e.note })) })),
    ...(rows.length ? {} : { note: SOURCE.mode === 'sim' ? '数据来自服务里模拟的现场，没有港口 EDI；接外部系统（feed、live、watch）以后才有' : '还没收到港口 EDI 的箱事件' }),
  };
};
/** 提议怎么执行：对建议卡的决定对应 /api/approve、/api/reject；调度台的修法要重新仿真，只能在网页里改 */
const proposalOut = (p: Proposal) => ({
  ...p,
  requests: p.actions.flatMap((a) => (a.kind === 'decide' ? [{ method: 'POST', path: a.action === 'approve' ? '/api/approve' : '/api/reject', body: { key: a.key, ...(a.option ? { option: a.option } : {}) } }] : [])),
  ...(p.actions.some((a) => a.kind === 'fix' || a.kind === 'day') ? { note: '调度台的修法和求解出来的排法要在网页的调度台里套用' } : {}),
});

const cardOut = (r: Rec) => ({ key: r.key, kind: r.kind, t: r.t, clock: clock(r.t), title: r.title, text: r.text, status: r.status, best: r.options[r.best]?.key, chosen: r.chosen, by: r.by, options: r.options.map((o) => ({ key: o.key, label: o.label, late: Math.round(o.late), hot: Math.round(o.hot), short: Math.round(o.short), cost: Math.round(o.cost), note: o.note, auto: o.auto, hasCommands: o.cmds.length > 0 })) });

// —— HTTP ——
/** 实时接入：数据来源是 live、watch 才收；设了密钥的要带对 */
const ingestHost: IngestHost = { accepting: source.accepting, mode: SOURCE.mode, token: INGEST_TOKEN, ingest: (a, text) => source.ingest(a, text) };
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
/** 请求出错：状态码和说明 */
class HttpError extends Error {
  constructor(
    readonly code: number,
    msg: string,
  ) {
    super(msg);
  }
}
/** JSON 请求体：超过 64 KB 回 413，不是 JSON 对象回 400 */
const body = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) {
      req.resume();
      return reject(new HttpError(413, `请求体太大（上限 ${MAX_BODY / 1024} KB）`));
    }
    let d = '';
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n <= MAX_BODY) d += c;
    });
    req.on('end', () => {
      if (n > MAX_BODY) return reject(new HttpError(413, `请求体太大（上限 ${MAX_BODY / 1024} KB）`));
      try {
        const v = d ? (JSON.parse(d) as unknown) : {};
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new HttpError(400, '请求体要是一个 JSON 对象'));
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, '请求体不是 JSON'));
      }
    });
  });
/** 浏览器发来的来源（有协议的网址或 null）才查；本机脚本、UE、MATLAB 一般不带。允许的：--allow-origin 列的、服务自己的地址 */
function originAllowed(o: string | string[] | undefined): boolean {
  if (typeof o !== 'string') return true;
  if (o !== 'null' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(o)) return true;
  return ALLOW_ORIGINS.has(o) || [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`].includes(o);
}
/** 设了访问密钥时，请求带对了没有（请求头，或者 extra：WebSocket 网址里、消息里带的） */
const authed = (headers: IncomingMessage['headers'], extra?: unknown): boolean => !TOKEN || tokenOk(tokenOf(headers), TOKEN) || (typeof extra === 'string' && tokenOk(extra, TOKEN));
/** 网址里的数字参数：不给用默认值，不是数回 400 */
function numParam(url: URL, name: string, def: number, int = false): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || (int && !Number.isInteger(v))) throw new HttpError(400, `参数 ${name} 要是${int ? '整数' : '数'}，现在是「${raw}」`);
  return v;
}

function handle(msg: Record<string, unknown>): { ok: boolean; card?: unknown; error?: string } {
  const r = handleMsg(msg);
  // 指令发出去以后：记录新出现的车、换算成外部系统的指令
  source.afterCommand();
  return r;
}
function handleMsg(msg: Record<string, unknown>): { ok: boolean; card?: unknown; error?: string } {
  const type = msg.type ?? msg.action;
  if (type === 'approve' || type === 'reject') {
    const r = loop.decide(String(msg.key), type, typeof msg.option === 'string' ? msg.option : undefined);
    return r ? { ok: true, card: cardOut(r) } : { ok: false, error: '没有这张待处理的建议卡' };
  }
  if (type === 'command' && msg.cmd && typeof msg.cmd === 'object') {
    loop.command({ ...(msg.cmd as Cmd), t: loop.t });
    return { ok: true };
  }
  if (type === 'control') {
    if (msg.speed !== undefined && (typeof msg.speed !== 'number' || !Number.isFinite(msg.speed))) return { ok: false, error: 'speed 要是数' };
    if (typeof msg.speed === 'number') speed = Math.max(0.1, Math.min(600, msg.speed));
    if (typeof msg.paused === 'boolean') paused = msg.paused;
    return { ok: true };
  }
  return { ok: false, error: `不认识的消息：${String(type)}` };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const origin = req.headers.origin;
  // 跨域：默认不回跨域头；--allow-origin 列的来源才回
  const listed = typeof origin === 'string' && ALLOW_ORIGINS.has(origin);
  if (listed) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'content-type, x-ingest-token, authorization');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return json(res, listed ? 204 : 403, {});
  // 改状态的请求（推数据、批准、否决、指令、控制）：不认识的浏览器来源拒绝；设了访问密钥的要带对（推数据另有实时接入的密钥）
  const ingest = req.method === 'POST' && url.pathname.startsWith('/api/ingest/');
  const changing = ingest || (req.method === 'POST' && ['/api/approve', '/api/reject', '/api/command', '/api/control'].includes(url.pathname));
  if (changing && !originAllowed(origin)) return json(res, 403, { error: `不接受来自 ${String(origin)} 的改动（用 --allow-origin 允许）` });
  if (changing && !ingest && !authed(req.headers)) return json(res, 401, { error: '要访问密钥：请求头 Authorization: Bearer <密钥>（或 x-ingest-token）' });
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, t: loop.t, clock: clock(loop.t), source: SOURCE.mode });
    if (req.method === 'POST' && url.pathname.startsWith('/api/ingest/')) {
      const r = await handleIngest(req, url.pathname.slice('/api/ingest/'.length), ingestHost);
      return json(res, r.code, r.body);
    }
    if (req.method === 'GET' && url.pathname === '/api/containers') return json(res, 200, containersOut());
    if (req.method === 'GET' && url.pathname === '/api/adapters') return json(res, 200, { t: loop.t, clock: clock(loop.t), ...source.adapters(clock) });
    if (req.method === 'GET' && url.pathname === '/api/outbox') {
      const since = Math.max(0, numParam(url, 'since', 0));
      const list = source.outbox.since(since);
      return json(res, 200, { next: list[list.length - 1]?.seq ?? since, list });
    }
    if (req.method === 'GET' && url.pathname === '/api/model') return json(res, 200, model());
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state());
    if (req.method === 'GET' && url.pathname === '/api/messages') {
      const since = Math.max(0, Math.floor(numParam(url, 'since', 0)));
      const limit = Math.max(1, Math.min(5000, Math.floor(numParam(url, 'limit', 1000))));
      const all = loop.field.msgs;
      return json(res, 200, { next: Math.min(all.length, since + limit), total: all.length, msgs: all.slice(since, since + limit) });
    }
    if (req.method === 'GET' && url.pathname === '/api/recommendations') return json(res, 200, loop.cards().map(cardOut));
    if (req.method === 'GET' && url.pathname === '/api/vehicle') {
      const vid = numParam(url, 'vid', -1, true);
      const v = Number.isInteger(vid) ? trace?.vehicles[vid] : undefined;
      const d = v ? detail(vid) : undefined;
      if (!v || !d) return json(res, 404, { error: `没有第 ${url.searchParams.get('vid')} 辆车` });
      const live = vehicles().find((x) => x.vid === vid);
      return json(res, 200, { vid, id: labelOf(vid), kind: v.kind, label: v.label, t: loop.t, clock: clock(loop.t), ...(live ? { x: live.x, z: live.z, heading: live.heading, act: live.act, delayMin: live.delayMin, state: live.state, ...(live.temp !== undefined ? { temp: live.temp } : {}) } : { act: '不在路上' }), ...d });
    }
    if (url.pathname === '/api/assistant' && (req.method === 'GET' || req.method === 'POST')) {
      const b = req.method === 'GET' ? { question: url.searchParams.get('q') ?? '', role: url.searchParams.get('role') ?? undefined } : await body(req);
      const q = String(b.question ?? '');
      // 角色（调度员、站长……）决定能批什么：不认识的角色按默认处理
      const role = ROLES.includes(b.role as Role) ? (b.role as Role) : undefined;
      const c = { ...assistCtx(), ...(role ? { role } : {}) };
      const base = bot.ask(q, c);
      // 大模型模式（STOREX_LLM 设了才用）：模型组织语言、按需要调工具；出任何错改用内置助手（回答里写明是哪个引擎）
      const llm = await llmProvider();
      const a = llm ? await askWithLlm(q, c, { provider: llm, maxRounds: LLM.maxRounds, maxTokens: LLM.maxTokens, timeoutMs: LLM.timeoutMs }, base) : { ...base, engine: 'builtin' };
      return json(res, 200, { t: loop.t, clock: clock(loop.t), ...a, proposals: a.proposals.map(proposalOut) });
    }
    if (req.method === 'GET' && url.pathname === '/api/assistant/tools') return json(res, 200, TOOLS.map((x) => ({ name: x.name, description: x.description, parameters: x.parameters })));
    if (req.method === 'GET' && url.pathname === '/api/watch') return json(res, 200, { t: loop.t, clock: clock(loop.t), items: watchList(assistCtx(), 12).map((w) => ({ ...w, ...(w.proposal ? { proposal: proposalOut(w.proposal) } : {}) })) });
    if (req.method === 'GET' && url.pathname === '/api/handover') {
      const sh = SHIFTS.find((x) => x.key === url.searchParams.get('shift'));
      const h = handover(assistCtx(), sh ?? reportShift(loop.t));
      return json(res, 200, { title: h.title, asOf: h.asOf, sections: h.sections, markdown: h.markdown });
    }
    if (req.method === 'GET' && url.pathname === '/api/review') return json(res, 200, review(loop.result(), loop.t));
    if (req.method === 'GET' && url.pathname === '/api/kpi') {
      // 分层看板：和网页同一套指标和默认阈值（服务里没有设施监控，设施层的港口、配送中心那几项没有值）
      const keys: Record<string, string> = { service: 'service', onTime18: 'onTime', costPerCase: 'costPerCase', co2PerCase: 'co2PerCase' };
      const mean = (refData as unknown as { gens: { gen: string; mean: Record<string, number> }[] }).gens.find((g) => g.gen === GEN)?.mean ?? {};
      const values = evaluate({ ctx: assistCtx(), summary: Object.fromEntries(Object.entries(keys).map(([k, key]) => [k, kpiOf(key).get(chain)])), base: Object.fromEntries(Object.entries(keys).flatMap(([k, key]) => (mean[key] !== undefined ? [[k, mean[key] as number]] : []))) });
      return json(res, 200, { t: loop.t, clock: clock(loop.t), kpis: values.map((v) => ({ key: v.def.key, level: v.def.level, label: v.def.label, unit: v.def.unit, value: v.value ?? null, state: v.state, ...(v.delta !== undefined ? { delta: v.delta } : {}) })) });
    }
    if (req.method === 'POST' && ['/api/approve', '/api/reject', '/api/command', '/api/control'].includes(url.pathname)) {
      const b = await body(req);
      const type = url.pathname.slice(5);
      const r = handle(type === 'command' ? { type, cmd: b } : { ...b, type });
      return json(res, r.ok ? 200 : 400, r);
    }
    json(res, 404, { error: '没有这个接口，见 server/protocol.md' });
  } catch (err) {
    if (err instanceof HttpError) return json(res, err.code, { error: err.message });
    json(res, 500, { error: String(err) });
  }
});

/** 可选的大模型模式（默认关；docs/06-llm-option.md）：按环境变量建一次提供方，建不起来就一直用内置助手 */
const LLM = llmConfig();
let llmMemo: Promise<LlmProvider | undefined> | undefined;
const llmProvider = (): Promise<LlmProvider | undefined> =>
  (llmMemo ??= createProvider(LLM).catch((err: unknown) => {
    process.stderr.write(`大模型模式没打开（${String(err)}），值班助手用内置的规则和模型。\n`);
    return undefined;
  }));

const clients = new Set<WsClient>();
server.on('upgrade', (req, socket) => {
  if (!(req.url ?? '').startsWith('/ws')) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  // 不认识的浏览器来源不让连（防网页偷偷连本机的服务）
  if (!originAllowed(req.headers.origin)) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  // 设了访问密钥：连接时带对了（请求头或网址里 ?token=），这个连接的指令就不用每条带
  const wsAuthed = authed(req.headers, new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? undefined);
  const c = acceptWs(req, socket);
  if (!c) return;
  clients.add(c);
  c.onClose = () => clients.delete(c);
  // 连接时请求头带了对的密钥，这个连接的 ingest 消息就不用每条带
  const ingestAuthed = !!INGEST_TOKEN && tokenOk(tokenOf(req.headers), INGEST_TOKEN);
  c.onMessage = (text) => {
    try {
      const msg = JSON.parse(text) as Record<string, unknown>;
      if (msg.type !== 'ingest' && !wsAuthed && !(typeof msg.token === 'string' && tokenOk(msg.token, TOKEN))) return c.send({ type: 'reply', ok: false, error: '要访问密钥：连接时带（请求头或网址里 ?token=），或者消息里带 token' });
      c.send({ type: 'reply', ...(msg.type === 'ingest' ? ingestMessage(msg, ingestAuthed, ingestHost) : handle(msg)) });
    } catch (err) {
      c.send({ type: 'reply', ok: false, error: String(err) });
    }
  };
  c.send({ type: 'hello', model: model(), state: state() });
});

// —— 时钟：每 250 毫秒按速度往前走，每走一分钟推一次；live、watch 不跑到数据前面（速度是最快的速度） ——
let acc = 0;
let sentMsgs = loop.field.msgs.length;
const seenCards = new Map<string, string>();
setInterval(() => {
  if (paused || loop.done) return;
  acc += speed * 60 * 0.25;
  let stepped = false;
  while (acc >= 60 && !loop.done && source.ready(loop.t + 60)) {
    stepLoop();
    acc -= 60;
    stepped = true;
  }
  // 等数据的时候不攒步数（数据来了按速度追，不一下子冲过去）
  if (!source.ready(loop.t + 60)) acc = Math.min(acc, 60);
  if (!stepped || !clients.size) return;
  const st = state();
  const msgs = loop.field.msgs.slice(sentMsgs).filter((m) => m.kind !== 'gps' && m.kind !== 'pos');
  sentMsgs = loop.field.msgs.length;
  const changed = loop.cards().filter((r) => seenCards.get(r.key) !== r.status);
  for (const r of changed) seenCards.set(r.key, r.status);
  for (const c of clients) {
    c.send({ type: 'tick', t: st.t, clock: st.clock, kpi: st.kpi, vehicles: st.vehicles, doors: st.doors });
    if (msgs.length) c.send({ type: 'msgs', msgs });
    if (changed.length) c.send({ type: 'cards', cards: changed.map(cardOut) });
  }
}, 250);

// watch：每秒读一遍目录（新文件、追加的部分）
if (SOURCE.mode === 'watch') setInterval(() => source.poll(), 1000);

server.listen(PORT, HOST, () => {
  const src =
    SOURCE.mode === 'sim'
      ? '模拟的现场'
      : SOURCE.mode === 'replay'
        ? `回放 ${SOURCE.file}（${RECORDING?.msgs ?? 0} 条数据）`
        : SOURCE.mode === 'feed'
          ? `外部系统 ${SOURCE.dir}（${feed?.items.length ?? 0} 条数据）`
          : SOURCE.mode === 'live'
            ? `实时推送 POST /api/ingest/tms|wms|edi${INGEST_TOKEN ? '（要密钥）' : ''}`
            : `盯着目录 ${SOURCE.dir}${INGEST_TOKEN ? '（推送要密钥）' : ''}`;
  process.stdout.write(`孪生服务：http://${HOST}:${PORT}/api/state · ws://${HOST}:${PORT}/ws · ${s.name} · 第 ${TRACE_DAY} 天 · 区域「${regionSpecText(REGION_SPEC)}」· 负荷「${LOAD}」· 现场「${LEVEL}」· 自动执行「${POLICY}」· 数据「${src}」· 每秒 ${speed} 分钟 · 从 ${clock(loop.t)} 开始\n`);
  process.stdout.write(`值班助手：${LLM.mode === 'off' ? '内置（规则 + 逻辑回归）' : `大模型 ${LLM.mode} · ${LLM.model}（出错时改用内置）`}\n`);
  process.stdout.write(`访问控制：${TOKEN ? '改状态要带访问密钥' : '没有访问密钥（只听本机）'}；跨域：${ALLOW_ORIGINS.size ? `只允许 ${[...ALLOW_ORIGINS].join('、')}` : '不回跨域头'}；请求体上限 ${MAX_BODY / 1024} KB\n`);
  if (LIVE && !INGEST_TOKEN && !LOOPBACK.includes(HOST)) process.stderr.write(`注意：服务听的是 ${HOST}，又没有设 --ingest-token，能连上这台机器的都能往孪生里推数据；至少设一个密钥（最好再放到有 HTTPS 的反向代理后面）\n`);
});
// 停服务时把记录和发件箱写完
const stop = (): void => {
  void source.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
