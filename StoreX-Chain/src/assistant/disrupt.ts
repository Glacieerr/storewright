import { STORE } from '../region/network';
import type { Incident } from '../twin/field';
import { Loop, type LoopInput, type LoopOpts, type LoopResult } from '../twin/loop';
import { posAt } from '../twin/track';
import { clock } from '../twin/twin';
import type { AssistCtx, ToolResult } from './types';

/**
 * 临时扰动的推演（「如果 M05 晚一个小时」「C05 停用两小时」「港口晚三个小时放柜」「物流园到门店的路封两小时」）：只读，什么都不执行。
 *
 * 用闭环孪生的现场模型（src/twin/field.ts，和孪生出卡时推演用的同一个）跑两遍这一天：一遍照常，一遍从此刻起加上这个扰动，
 * 两遍都不采取措施（开环、不执行建议），比到今天结束的迟到、超温、缺货、等门分钟和成本。扰动怎么放进现场模型：
 * - 一趟车晚 N 分钟：还没出发的晚 N 分钟出发；已经在路上的在此刻所在的位置原地停 N 分钟（在站里作业的不受影响，回答里说明）；
 * - 班轮、班列、航班晚 N 分钟：它本身晚，接驳的车（在它卸货的地方、它到了以后才出发的集卡、班列、空运冷藏车）跟着晚同样的时间；
 *   配送中心按库存发货，不跟着等；
 * - 一段路封 N 小时：在这段路上放一个封路点（车开到那里停住，到时候放行）；
 * - 一个月台门停用一段时间：按调度台的月台门预约，把这段时间里排在这个门的车挪到同类（常温 / 冷链）最早空出来的门，
 *   挪不开的等门重新开；出库的车按等的时间晚出发，再交给现场模型比。
 * 两遍用的是同一个随机种子和同样的现场状况，差别只来自这个扰动。
 */
export type Disruption =
  | { kind: 'vehicle'; vid: number; id: string; min: number }
  | { kind: 'carrier'; vid: number; id: string; min: number }
  | { kind: 'door'; door: string; from: number; to: number }
  | { kind: 'road'; a: string; b?: string; label: string; from: number; to: number };

const OPEN: LoopOpts = { closed: false, policy: 'manual', decisions: [] };
const CARRIER = new Set(['vessel', 'train', 'rail', 'flight']);
const FEEDER = new Set(['drayage', 'rail', 'train', 'airTruck']);
const PLACE_WORDS: [RegExp, string][] = [
  [/(港口|码头|港区)/, 'port'],
  [/(机场|货站|空港)/, 'airport'],
  [/(铁路货运站|货运站|铁路场站)/, 'rail'],
  [/(物流园|配送中心|仓库)/, 'dc'],
  [/(门店|综合店|店里|店)/, 'store'],
];
const PLACE_LABEL: Record<string, string> = { port: '港口', airport: '机场', rail: '铁路货运站', dc: '物流园配送中心', store: '门店' };

type Op = { id: string; kind: string; vehicle: number; from?: string; to?: string; t0: number; t1: number; door?: string; stops?: { key: string }[] };
const opsOf = (ctx: AssistCtx): Op[] => ctx.board.ops as unknown as Op[];

/** 时长：「一个半小时」「俩小时」「90 分钟」「半小时」→ 分钟 */
export function durationMin(q: string): number | undefined {
  const m = /(\d+(?:\.\d+)?|[一二两俩三四五六七八九十]+)?\s*个?\s*(半)?\s*(小时|钟头|分钟|分(?!店|拣|钟))/.exec(q);
  if (!m || (!m[1] && !m[2])) return /半小时|半个小时|半个钟头/.test(q) ? 30 : undefined;
  const cn: Record<string, number> = { 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const raw = m[1] ?? '';
  const n = raw === '' ? 0 : /\d/.test(raw) ? Number(raw) : raw.length === 2 && raw[0] === '十' ? 10 + (cn[raw[1] as string] ?? 0) : raw.length === 2 && raw[1] === '十' ? (cn[raw[0] as string] ?? 1) * 10 : (cn[raw] ?? 1);
  const hours = m[3] === '小时' || m[3] === '钟头';
  return hours ? Math.round((n + (m[2] ? 0.5 : 0)) * 60) : n;
}

/** 节点的键：港口、机场按调度台里的班轮、航班作业的终点；物流园 DC；门店是本店的键；铁路货运站 RAIL_DC */
function nodeKey(ctx: AssistCtx, place: string): string | undefined {
  if (place === 'dc') return 'DC';
  if (place === 'store') return STORE.key;
  if (place === 'rail') return 'RAIL_DC';
  const kind = place === 'port' ? 'vessel' : 'flight';
  return opsOf(ctx).find((o) => o.kind === kind && o.to)?.to;
}

/** 问题里说的扰动；认不出来返回 undefined（交给建议卡的推演或者问清楚） */
export function parseDisruption(q: string, e: { vehicles: { vid: number; id: string }[]; doors: string[] }, ctx: AssistCtx): Disruption | undefined {
  const min = durationMin(q);
  const now = ctx.t;
  if (e.doors[0] && /(停用|关闭|关了|关掉|坏了|故障|维修|检修|不能用|封)/.test(q)) return { kind: 'door', door: e.doors[0], from: now, to: now + (min ?? 120) * 60 };
  const late = /(晚|延误|推迟|迟到|耽误|放柜|误点|堵|塞车|拥堵|被卡|卡住)/.test(q);
  const ops = opsOf(ctx);
  const opOf = (vid: number) => ops.find((o) => o.vehicle === vid);
  const v = e.vehicles[0];
  if (v && late) {
    const op = opOf(v.vid);
    return { kind: op && CARRIER.has(op.kind) ? 'carrier' : 'vehicle', vid: v.vid, id: op?.id ?? v.id, min: min ?? 60 };
  }
  if (/((路|高速|道路|桥|隧道|干道|国道).{0,6}(封|堵死|断|塌|中断|施工))|封路|断路/.test(q)) {
    const places = PLACE_WORDS.filter(([re]) => re.test(q)).map(([, k]) => k);
    const keys = places.map((p) => nodeKey(ctx, p)).filter((x): x is string => !!x);
    if (!keys.length) return undefined;
    const label = places.length >= 2 ? `${PLACE_LABEL[places[0] as string]}到${PLACE_LABEL[places[1] as string]}的路` : `进出${PLACE_LABEL[places[0] as string]}的路`;
    return { kind: 'road', a: keys[0] as string, ...(keys[1] ? { b: keys[1] } : {}), label, from: now, to: now + (min ?? 120) * 60 };
  }
  if (late) {
    const kind = /(港口|码头|班轮|船|放柜|靠泊|集装箱)/.test(q) ? 'vessel' : /(班列|火车|铁路)/.test(q) ? 'train' : /(航班|货机|飞机)/.test(q) ? 'flight' : undefined;
    const op = kind ? ops.filter((o) => (o.kind === kind || (kind === 'train' && o.kind === 'rail')) && o.vehicle >= 0).sort((a, b) => Math.abs(a.t0 - now) - Math.abs(b.t0 - now) || a.id.localeCompare(b.id))[0] : undefined;
    if (op) return { kind: 'carrier', vid: op.vehicle, id: op.id, min: min ?? 60 };
  }
  return undefined;
}

interface Kpis {
  late: number;
  lateStops: number;
  hot: number;
  short: number;
  door: number;
  cost: number;
}
const kpisOf = (r: LoopResult): Kpis => ({ late: Math.round(r.kpi.lateMin), lateStops: r.kpi.lateStops, hot: Math.round(r.kpi.hotMin), short: Math.round(r.kpi.shortMin), door: Math.round(r.kpi.doorWaitMin + r.kpi.dockWaitMin), cost: Math.round(r.kpi.cost) });

const baseCache = new WeakMap<LoopInput, LoopResult>();
function baseline(input: LoopInput): LoopResult {
  let r = baseCache.get(input);
  if (!r) {
    const loop = new Loop(input, OPEN);
    while (!loop.done) loop.step();
    r = loop.result();
    baseCache.set(input, r);
  }
  return r;
}

/** 一段路上的封路点：两地之间（或进出一地）的一段行驶轨迹上取一点 */
function roadPoint(input: LoopInput, ops: readonly Op[], a: string, b: string | undefined): { x: number; z: number } | undefined {
  for (const o of ops) {
    const keys = new Set([o.from, o.to, ...(o.stops ?? []).map((x) => x.key)]);
    const hit = b ? keys.has(a) && keys.has(b) : keys.has(a);
    if (!hit || o.vehicle < 0) continue;
    const segs = input.vehicles[o.vehicle]?.segs.filter((s) => s.pts.length >= 4) ?? [];
    const s = b ? segs[0] : o.to === a ? segs[segs.length - 1] : segs[0];
    if (!s) continue;
    const span = s.t1 - s.t0;
    const at = b ? s.t0 + span / 2 : o.to === a ? s.t0 + span * 0.85 : s.t0 + span * 0.15;
    return posAt(s, at);
  }
  return undefined;
}

/** 月台门停用：调度台的预约挪到同类最早空出来的门，挪不开的等门重新开（每趟车等了多少秒） */
function doorWaits(ctx: AssistCtx, d: Extract<Disruption, { kind: 'door' }>): { op: string; wait: number; moved?: string; mode: string }[] {
  const doors = ctx.board.doors as unknown as { id: string; bookings: { door: string; op: string; t0: number; t1: number; mode: string }[] }[];
  const same = doors.filter((x) => x.id !== d.door && x.id[0] === d.door[0]);
  const busy = new Map(same.map((x) => [x.id, x.bookings.map((b) => [b.t0, b.t1] as [number, number])]));
  const hit = (doors.find((x) => x.id === d.door)?.bookings ?? []).filter((b) => b.t1 > d.from && b.t0 < d.to).sort((a, b) => a.t0 - b.t0 || a.op.localeCompare(b.op));
  const out: { op: string; wait: number; moved?: string; mode: string }[] = [];
  for (const b of hit) {
    const len = b.t1 - b.t0;
    let best: { door: string; start: number } | undefined;
    for (const [door, list] of busy) {
      let start = Math.max(b.t0, d.from <= b.t0 ? b.t0 : d.from);
      for (const [s0, s1] of [...list].sort((x, y) => x[0] - y[0])) if (start < s1 && start + len > s0) start = s1;
      if (!best || start < best.start) best = { door, start };
    }
    const reopen = Math.max(b.t0, d.to);
    if (best && best.start < reopen) {
      busy.get(best.door)?.push([best.start, best.start + len]);
      out.push({ op: b.op, wait: Math.max(0, best.start - b.t0), moved: best.door, mode: b.mode });
    } else out.push({ op: b.op, wait: reopen - b.t0, mode: b.mode });
  }
  return out;
}

const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const CITE = '闭环孪生的现场模型（同一天、同一个随机种子跑两遍，不采取措施）';

/** what_if 的临时扰动：推演结果和照常比（只读） */
export function whatIfDisruption(ctx: AssistCtx, args: Record<string, unknown>): ToolResult {
  const d = args.disruption as Disruption;
  const res = (text: string, data: Record<string, unknown> = {}): ToolResult => ({ tool: 'what_if', args, data, text, cite: CITE });
  const base = ctx.sim?.();
  if (!base) return res('这里没有现场模型的数据（孪生没接上），推演不了临时扰动；可以推演建议卡的几个做法（「如果第一条不处理会怎样」）。');
  const input = base.input;
  const ops = opsOf(ctx);
  const opById = new Map(ops.map((o) => [o.id, o] as const));
  const start = new Map<number, number>();
  const stall: { vid: number; sec: number }[] = [];
  const incidents: Incident[] = [];
  const affected: string[] = [];
  const notes: string[] = [];
  const at = ctx.t;
  const begun = (vid: number) => (input.vehicles[vid]?.segs[0]?.t0 ?? Infinity) <= at;
  const delay = (vid: number, sec: number) => {
    if (begun(vid)) stall.push({ vid, sec });
    else start.set(vid, (start.get(vid) ?? 0) + sec);
  };
  let head: string;
  let doorData: Record<string, unknown> = {};
  if (d.kind === 'vehicle' || d.kind === 'carrier') {
    delay(d.vid, d.min * 60);
    affected.push(d.id);
    head = `如果 ${d.id} 从此刻起晚 ${d.min} 分钟（${begun(d.vid) ? '已经出发：按在此刻的位置原地停这么久算，在站里作业时不受影响' : '还没出发：按晚这么久出发算'}）`;
    if (d.kind === 'carrier') {
      const op = opById.get(d.id);
      // 接驳：从它卸货的地方出发、在它到了以后而且此刻还没出发的集卡、班列、空运冷藏车（等它的货）
      const feeders = ops.filter((o) => op && o.vehicle >= 0 && o.vehicle !== op.vehicle && FEEDER.has(o.kind) && o.from === op.to && o.t0 >= Math.max(op.t0, at));
      for (const f of feeders) {
        delay(f.vehicle, d.min * 60);
        affected.push(f.id);
      }
      if (feeders.length) notes.push(`接驳的 ${feeders.length} 趟车（${feeders.map((f) => f.id).join('、')}）跟着晚 ${d.min} 分钟；配送中心按库存发货，不跟着等。`);
      else notes.push('没有在它卸货以后才出发的接驳车。');
    }
  } else if (d.kind === 'road') {
    const p = roadPoint(input, ops, d.a, d.b);
    if (!p) return res(`调度台里今天没有车走${d.label}，封了也不影响今天的车。`, { road: d.label });
    incidents.push({ id: 'X1', x: p.x, z: p.z, r: 80, f: 1e6, t0: d.from, t1: d.to, text: '推演：封路' });
    head = `如果${d.label}从 ${clock(d.from)} 封到 ${clock(d.to)}（车开到封路点停住，到时候放行）`;
  } else {
    const waits = doorWaits(ctx, d);
    doorData = { waits: waits.map((w) => ({ op: w.op, waitMin: Math.round(w.wait / 60), ...(w.moved ? { moved: w.moved } : {}) })), totalMin: Math.round(waits.reduce((s, w) => s + w.wait, 0) / 60), n: waits.length };
    head = `如果 ${d.door} 从 ${clock(d.from)} 停用到 ${clock(d.to)}`;
    if (!waits.length) return res(`${head}：这段时间调度台没有车排在 ${d.door}，不影响今天的车。`, { door: d.door, from: d.from, to: d.to, affected: 0 });
    for (const w of waits) {
      affected.push(w.op);
      const o = opById.get(w.op);
      if (o && o.vehicle >= 0 && w.mode === 'load' && w.wait > 0) delay(o.vehicle, w.wait);
    }
    const moved = waits.filter((w) => w.moved);
    const waited = waits.filter((w) => w.wait > 0);
    notes.push(`这段时间排在 ${d.door} 的车 ${waits.length} 趟：${moved.length} 趟能挪到同类的门（${moved.map((w) => `${w.op} → ${w.moved}${w.wait > 0 ? `，等 ${n0(w.wait / 60)} 分钟` : ''}`).join('；') || '无'}）${waits.length - moved.length ? `，${waits.length - moved.length} 趟要等门重新开（${waits.filter((w) => !w.moved).map((w) => `${w.op} 等 ${n0(w.wait / 60)} 分钟`).join('；')}）` : ''}；合计等 ${n0(waited.reduce((a, w) => a + w.wait, 0) / 60)} 分钟。出库的车按等的时间晚出发；进库的车晚卸不影响今天的门店（配送中心按库存发货）。`);
  }
  const b = kpisOf(baseline(input));
  const loop = new Loop(input, OPEN);
  for (const [vid, sec] of start) loop.field.d.startDelay.set(vid, (loop.field.d.startDelay.get(vid) ?? 0) + sec);
  if (stall.length || incidents.length) {
    while (!loop.done && loop.t < at) loop.step();
    for (const s of stall) {
      const f = loop.field.fv.find((x) => x.vid === s.vid);
      if (!f || f.finished) continue;
      const seg = f.v.segs.find((g) => f.tau >= g.t0 && f.tau < g.t1) ?? f.v.segs[0];
      if (!seg) continue;
      const p = posAt(seg, f.tau);
      loop.field.d.incidents.push({ id: `W${s.vid}`, x: p.x, z: p.z, r: 60, f: 1e6, t0: loop.t, t1: loop.t + s.sec, text: '推演：原地停车' });
    }
    loop.field.d.incidents.push(...incidents);
  }
  while (!loop.done) loop.step();
  const a = kpisOf(loop.result());
  const line = (name: string, x: number, y: number, unit: string) => `- ${name}：${n0(x)} → ${n0(y)} ${unit}${y !== x ? `（${y > x ? '多' : '少'} ${n0(Math.abs(y - x))}）` : '（不变）'}`;
  const lines = [
    `${head}，到今天结束和照常比（现场模型推演，两遍都不采取措施，不改任何数据）：`,
    line('迟到', b.late, a.late, '分钟') + `；晚到的站 ${b.lateStops} → ${a.lateStops} 个`,
    line('超温', b.hot, a.hot, '分钟'),
    line('缺货', b.short, a.short, '分钟'),
    line('等月台门、收货口', b.door, a.door, '分钟'),
    line('措施和运输多花', b.cost, a.cost, '美元'),
    ...notes,
    `受影响的作业：${affected.join('、') || '无'}。这是推演，不执行任何东西；要采取措施（改门、改派、通知）照常走建议卡或调度台。`,
  ];
  const conclusion = a.late === b.late && a.hot === b.hot && a.short === b.short ? `${head}：今天的迟到、超温、缺货都不变。` : `${head}：迟到 ${n0(b.late)} → ${n0(a.late)} 分钟，缺货 ${n0(b.short)} → ${n0(a.short)} 分钟，超温 ${n0(b.hot)} → ${n0(a.hot)} 分钟。`;
  const diff = Object.fromEntries((Object.keys(b) as (keyof Kpis)[]).map((k) => [k, Math.abs(a[k] - b[k])]));
  return { tool: 'what_if', args, data: { disruption: d, base: b, alt: a, diff, affected, ...doorData, ...(d.kind === 'vehicle' || d.kind === 'carrier' ? { min: d.min } : {}) }, text: lines.join('\n'), cite: CITE, conclusion };
}
