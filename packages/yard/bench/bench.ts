/**
 * 排程的耗时、内存和「结果一字不差」的指纹（改引擎的性能时用：先存一份指纹，改完再比）。
 * Scheduling time, retained memory and an exact-output fingerprint, for performance work on the engine.
 *
 *   npm run bench -w @storewright/yard                       # 每个设置排 3 次（每次一个内容相同的新布置对象，不走缓存），取最快的
 *   npm run bench -w @storewright/yard -- --mem 8            # 再算内存：每个设置留 8 份布置 + 排程，GC 以后每份多少 MB
 *   npm run bench -w @storewright/yard -- --hash a.json      # 存指纹：每个设置的时间线、分段、甩挂作业和逐秒的位姿
 *   npm run bench -w @storewright/yard -- --check a.json     # 和存的指纹比，有一个不一样就退出码 1
 *   …… --random 256                                          # 指纹再加 256 组随机设置（门数、负荷、进场方式、进深、甩挂、取挂、靠台车道进场）
 *
 * 设置：test/overload.test.ts 的超负荷矩阵，加上浏览器演示的各种选项（6 个门、每小时 10 辆、种子 7）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { planYard, poseAt, scheduleYard, type YardInput, type YardPlan, type YardSchedule, type YardVehicle, type YardVisit } from '../src/index';

const argv = process.argv.slice(2);
const opt = (k: string): string | undefined => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const REPS = Number(opt('reps') ?? 3);
const MEM = Number(opt('mem') ?? 0);
const HASH = opt('hash');
const CHECK = opt('check');
const RANDOM = Number(opt('random') ?? 0);

interface Case {
  doors: number;
  rate: number;
  side?: 'left' | 'right';
  from?: 'back' | 'front';
  access?: 'drive' | 'street';
  drop?: boolean;
  depth?: number;
  gap?: number;
  seed?: number;
  pitch?: number;
  /** 随机设置的花样：一部分改成取挂（hook）、从靠台车道进场（via court）、指定甩挂车位 */
  hook?: number;
  court?: number;
  stallPref?: number;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = 6 * 3600;
const WINDOW = 4 * 3600;

function inputOf(c: Case): YardInput {
  const pitch = c.pitch ?? 4.3;
  const doors = Array.from({ length: c.doors }, (_, i) => ({ x: i * pitch, id: `D${i + 1}` }));
  const span = (c.doors - 1) * pitch;
  return { doors, x0: -70, x1: span + 70, depth: c.depth ?? 140, side: c.side ?? 'right', from: c.from ?? 'back', access: c.access ?? 'drive', ...(c.drop ? { drop: 6 } : {}) };
}

/** 和浏览器演示、超负荷测试同一套到车：泊松到达、按门空出来的先后分门，三分之一的半挂车甩挂 */
function visitsOf(plan: YardPlan, c: Case): YardVisit[] {
  const r = rng(c.seed ?? 7);
  const free = plan.doors.map(() => T0);
  const out: YardVisit[] = [];
  let t = T0;
  let i = 0;
  while (t < T0 + WINDOW) {
    t += Math.max(c.gap ?? 75, (-Math.log(1 - r()) * 3600) / c.rate);
    if (t >= T0 + WINDOW) break;
    const u = r();
    const vehicle: YardVehicle = u < 0.38 ? 'semi' : u < 0.58 ? 'reefer' : u < 0.7 ? 'chassis' : u < 0.88 ? 'truck' : 'van';
    let door = 0;
    for (let k = 1; k < free.length; k++) if ((free[k] as number) < (free[door] as number)) door = k;
    const rig = vehicle === 'semi' || vehicle === 'reefer' || vehicle === 'chassis';
    const work = vehicle === 'van' ? 600 + r() * 300 : vehicle === 'truck' ? 1200 + r() * 600 : 1800 + r() * 900;
    const drop = !!c.drop && rig && vehicle !== 'chassis' && r() < 0.35;
    const dockAt = Math.max(t + (drop ? 900 : 480), (free[door] as number) + 420);
    const leaveAt = dockAt + work;
    free[door] = leaveAt + 150;
    out.push({ id: `V${++i}`, vehicle, door, arrive: Math.round(t), dockAt: Math.round(dockAt), leaveAt: Math.round(leaveAt), ...(drop ? { mode: 'drop' as const, pickupAt: Math.round(leaveAt + 1500 + r() * 1800) } : {}) });
  }
  if (c.hook || c.court || c.stallPref) {
    const r2 = rng((c.seed ?? 7) * 31 + 5);
    for (const v of out) {
      const x = r2();
      if (c.hook && (v.vehicle === 'semi' || v.vehicle === 'reefer') && !v.mode && x < c.hook) {
        v.mode = 'hook';
        v.arrive = Math.round(v.leaveAt + 600 + r2() * 1800);
      } else if (c.court && !v.mode && x > 1 - c.court) v.via = 'court';
      if (c.stallPref && v.mode && r2() < c.stallPref) v.stall = Math.floor(r2() * 7) - 1;
    }
  }
  return out;
}

const MATRIX: Case[] = [
  { doors: 6, rate: 10 },
  { doors: 3, rate: 8 },
  { doors: 6, rate: 10, drop: true },
  { doors: 6, rate: 16, drop: true },
  { doors: 3, rate: 24 },
  { doors: 14, rate: 24, drop: true },
  { doors: 14, rate: 4 },
  { doors: 10, rate: 24, from: 'front' },
  { doors: 6, rate: 20, side: 'left' },
  { doors: 10, rate: 16, side: 'left', from: 'front', access: 'street', drop: true },
  { doors: 6, rate: 16, access: 'street', seed: 11 },
  { doors: 6, rate: 24, depth: 80 },
  { doors: 10, rate: 24, depth: 80, side: 'left', from: 'front' },
  { doors: 6, rate: 24, gap: 0 },
  { doors: 6, rate: 24, gap: 0, drop: true, side: 'left', from: 'front', access: 'street' },
];
const cases: Array<{ name: string; c: Case; timed: boolean }> = MATRIX.map((c) => ({ name: `overload ${JSON.stringify(c)}`, c, timed: true }));
for (const side of ['right', 'left'] as const)
  for (const from of ['back', 'front'] as const)
    for (const access of ['drive', 'street'] as const)
      for (const drop of [false, true]) {
        if (side === 'right' && from === 'back' && access === 'drive' && !drop) continue; // 就是矩阵的第一组
        cases.push({ name: `demo ${side} ${from} ${access}${drop ? ' drop' : ''}`, c: { doors: 6, rate: 10, side, from, access, drop, seed: 7 }, timed: true });
      }
if (RANDOM > 0) {
  const R = rng(20261108);
  for (let k = 0; k < RANDOM; k++) {
    const c: Case = {
      doors: 3 + Math.floor(R() * 12),
      rate: 4 + Math.floor(R() * 21),
      side: R() < 0.5 ? 'right' : 'left',
      from: R() < 0.5 ? 'back' : 'front',
      access: R() < 0.5 ? 'drive' : 'street',
      drop: R() < 0.4,
      depth: [70, 80, 95, 110, 140, 160][Math.floor(R() * 6)] as number,
      gap: [0, 30, 75, 75][Math.floor(R() * 4)] as number,
      seed: 1 + Math.floor(R() * 9999),
      pitch: [4.3, 4.3, 4.0, 5.0][Math.floor(R() * 4)] as number,
    };
    const extra = R();
    if (extra < 0.15) c.hook = 0.25;
    else if (extra < 0.3) c.court = 0.2;
    else if (extra < 0.4) c.stallPref = 0.5;
    cases.push({ name: `random#${k} ${JSON.stringify(c)}`, c, timed: false });
  }
}

/** 一个内容相同的新布置对象（planYard 按输入缓存，排程和路线按布置对象缓存：每次都从头排） */
const freshPlan = (c: Case): YardPlan => structuredClone(planYard(inputOf(c)));

// —— 耗时 ——
let total = 0;
for (const cs of cases.filter((x) => x.timed)) {
  const times: number[] = [];
  let n = 0;
  for (let k = 0; k < REPS; k++) {
    const plan = freshPlan(cs.c);
    const visits = visitsOf(plan, cs.c);
    n = visits.length;
    const t = performance.now();
    scheduleYard(plan, visits);
    times.push(performance.now() - t);
  }
  const best = Math.min(...times);
  total += best;
  console.log(`${cs.name.padEnd(96)} ${String(n).padStart(3)} visits ${best.toFixed(0).padStart(6)} ms`);
}
console.log(`total ${total.toFixed(0)} ms (best of ${REPS} per setting)`);

// —— 内存 ——
const gc = (globalThis as { gc?: () => void }).gc;
if (MEM > 0 && !gc) console.log('--mem needs node --expose-gc (npm run bench passes it)');
if (MEM > 0 && gc) {
  const used = () => {
    gc();
    gc();
    const m = process.memoryUsage();
    return m.heapUsed + m.external;
  };
  for (const c of [MATRIX[0], MATRIX[5], MATRIX[9], MATRIX[13]] as Case[]) {
    scheduleYard(freshPlan(c), visitsOf(freshPlan(c), c));
    const keep: YardSchedule[] = [];
    const m0 = used();
    for (let k = 0; k < MEM; k++) {
      const plan = freshPlan(c);
      keep.push(scheduleYard(plan, visitsOf(plan, c)));
    }
    const m1 = used();
    console.log(`memory ${JSON.stringify(c)}: ${((m1 - m0) / keep.length / 1048576).toFixed(2)} MB per layout + schedule`);
  }
}

// —— 指纹 ——
if (HASH || CHECK) {
  // 数一律按 String(v)（能原样读回的最短写法），−0 单独写；位姿按 float64 原样
  const exact = (_k: string, v: unknown) => (typeof v === 'number' ? `#${Object.is(v, -0) ? '-0' : String(v)}` : v);
  const SEG = ['hold', 'approach', 'queue', 'enter', 'wait', 'back', 'prep', 'docked', 'pullout', 'exit', 'drop', 'hook', 'shunt', 'pool'];
  const ROLE = ['truck', 'trailer', 'shunter', 'bobtail'];
  const dimsKey = new WeakMap<object, string>();
  const keyOf = (d: object) => {
    let k = dimsKey.get(d);
    if (k === undefined) dimsKey.set(d, (k = JSON.stringify(d, exact)));
    return k;
  };
  const out: Record<string, string> = {};
  for (const cs of cases) {
    const h = createHash('sha256');
    const plan = freshPlan(cs.c);
    const s = scheduleYard(plan, visitsOf(plan, cs.c));
    h.update(JSON.stringify({ timelines: s.timelines, shunts: s.shunts, notes: s.notes }, exact));
    const t1 = Math.max(T0 + WINDOW, ...s.timelines.map((tl) => (Number.isFinite(tl.goneAt) ? tl.goneAt : 0))) + 120;
    const buf = new Float64Array(9);
    for (const tl of s.timelines) {
      // 自己靠台的车只在自己的分段里有位姿；甩挂的挂车整个时段都看（车位里停着也有位姿）
      const live = tl.segs.some((x) => x.kind === 'pullout');
      const a = live && tl.segs.length ? Math.floor((tl.segs[0] as { t0: number }).t0) - 2 : T0 - 60;
      const b = live && tl.segs.length ? Math.ceil((tl.segs[tl.segs.length - 1] as { t1: number }).t1) + 2 : t1;
      for (let t = a; t <= b; t += 1) {
        const info = poseAt(tl, t);
        if (!info) {
          h.update('-');
          continue;
        }
        h.update(`${SEG.indexOf(info.seg)}${info.hazard ? 'h' : ''}${info.brake ? 'b' : ''}`);
        for (const u of info.units) {
          const p = u.pose;
          buf.set([ROLE.indexOf(u.role), p.x, p.z, p.heading, p.trailer, p.reversing ? 1 : 0, p.speed, p.steer, Object.keys(p).length]);
          h.update(new Uint8Array(buf.buffer));
          h.update(keyOf(u.dims));
        }
      }
    }
    out[cs.name] = h.digest('hex');
  }
  if (HASH) {
    writeFileSync(HASH, JSON.stringify(out, null, 1));
    console.log(`fingerprints of ${cases.length} settings written to ${HASH}`);
  }
  if (CHECK) {
    const old = JSON.parse(readFileSync(CHECK, 'utf8')) as Record<string, string>;
    const keys = Object.keys(out).filter((k) => k in old);
    const bad = keys.filter((k) => old[k] !== out[k]);
    for (const k of bad.slice(0, 10)) console.log(`DIFFERENT ${k}`);
    console.log(bad.length ? `${bad.length} of ${keys.length} settings differ` : `all ${keys.length} settings identical`);
    if (bad.length || !keys.length) process.exitCode = 1;
  }
}
