import { describe, expect, it } from 'vitest';
import { OverlapAuditor, type Body } from '@storewright/overlap-audit';
import { checkRoute, courtResources, footprint, planYard, poseAt, scheduleYard, yardRoute, type YardInput, type YardPlan, type YardSchedule, type YardVehicle, type YardVisit } from '../src/index';
import { MIN_WORK, PREP } from '../src/consts';

/**
 * 超负荷矩阵：负荷（每小时 4–24 辆）× 门数（3–14）× 进场方式（左头 / 右头、墙后 / 远端、专用通道 / 信号灯支路、完整 / 紧凑 / 只有靠台车道的布置）
 * × 甩挂，按浏览器演示的办法排一上午的到车，逐秒用 @storewright/overlap-audit 审计车身矩形：重叠必须是 0。
 * 同时检查原有的规则：每个门、每种车的路线（倒车不碰两边停着的车、铰接角 ≤ 65°、挂车摆正、转弯半径）、待命车道先进先出、
 * 同一区段同一时间一辆车调车、同一个门不会同时有两辆车、时刻语义（到达、开始装卸、拉出；窗口不够标 tight）、结果确定。
 * 在场外等候区等（hold 段）的车不在场里，不算（场地把它画在自己的等候区）。
 */
interface Case {
  doors: number;
  rate: number;
  side?: 'left' | 'right';
  from?: 'back' | 'front';
  access?: 'drive' | 'street';
  drop?: boolean;
  depth?: number;
  /** 登记亭让来车至少隔几秒进场（演示是 75；0 = 可以同时到） */
  gap?: number;
  seed?: number;
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

function inputOf(c: Case, extra: Partial<YardInput> = {}): YardInput {
  const doors = Array.from({ length: c.doors }, (_, i) => ({ x: i * 4.3, id: `D${i + 1}` }));
  const span = (c.doors - 1) * 4.3;
  return { doors, x0: -70, x1: span + 70, depth: c.depth ?? 140, side: c.side ?? 'right', from: c.from ?? 'back', access: c.access ?? 'drive', ...(c.drop ? { drop: 6 } : {}), ...extra };
}

/** 和浏览器演示（demo/main.ts）同一套到车：泊松到达、按门空出来的先后分门，三分之一的半挂车甩挂 */
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
  return out;
}

type Unit = { id: string; seg: string; u: NonNullable<ReturnType<typeof poseAt>>['units'][number] };
function unitsAt(s: YardSchedule, t: number): Unit[] {
  const out: Unit[] = [];
  for (const tl of s.timelines) {
    const info = poseAt(tl, t);
    if (!info || info.seg === 'hold') continue;
    for (const u of info.units) out.push({ id: tl.visit.id, seg: info.seg, u });
  }
  return out;
}

/** 逐秒审计车身矩形（不放大不缩小），返回重叠的「车对 × 秒」和前几个例子 */
function audit(s: YardSchedule, t0: number, t1: number): { n: number; examples: string[] } {
  const examples: string[] = [];
  const auditor = new OverlapAuditor<{ id: string; seg: string }>({
    skip: (a, b) => a.data?.id === b.data?.id,
    area: () => 'yard',
    onOverlap: (o) => {
      if (examples.length < 5) examples.push(`${o.t}s ${o.a.data?.id}:${o.a.data?.seg} × ${o.b.data?.id}:${o.b.data?.seg}`);
    },
  });
  for (let t = t0; t <= t1; t += 1) {
    const bodies: Body<{ id: string; seg: string }>[] = [];
    for (const x of unitsAt(s, t))
      for (const b of footprint(x.u.dims, x.u.pose)) bodies.push({ type: x.u.role, shape: { cx: b.x, cz: b.z, ux: Math.sin(b.h), uz: Math.cos(b.h), hl: b.hl, hw: b.hw }, data: { id: x.id, seg: x.seg } });
    auditor.step(t, bodies, 1);
  }
  const tot = auditor.tally.total('yard');
  return { n: tot.static + tot.moving, examples };
}

const MATRIX: Case[] = [
  { doors: 6, rate: 10 }, // 演示的默认设置
  { doors: 3, rate: 8 }, // 上一版：225 车·秒
  { doors: 6, rate: 10, drop: true }, // 上一版：86 车·秒
  { doors: 6, rate: 16, drop: true }, // 上一版：上万车·秒
  { doors: 3, rate: 24 },
  { doors: 14, rate: 24, drop: true },
  { doors: 14, rate: 4 },
  { doors: 10, rate: 24, from: 'front' },
  { doors: 6, rate: 20, side: 'left' },
  { doors: 10, rate: 16, side: 'left', from: 'front', access: 'street', drop: true },
  { doors: 6, rate: 16, access: 'street', seed: 11 },
  { doors: 6, rate: 24, depth: 80 }, // 紧凑布置：驶离的车横穿进场的转弯
  { doors: 10, rate: 24, depth: 80, side: 'left', from: 'front' }, // 只有靠台车道：在进场道路上排队
  { doors: 6, rate: 24, gap: 0 }, // 来车可以同时到进场点
  { doors: 6, rate: 24, gap: 0, drop: true, side: 'left', from: 'front', access: 'street' },
];

describe('超负荷矩阵：车身不重叠，原有规则照旧', () => {
  it.each(MATRIX.map((c) => [JSON.stringify(c), c] as const))('%s', (_name, c) => {
    const plan = planYard(inputOf(c));
    const visits = visitsOf(plan, c);
    const s = scheduleYard(plan, visits);
    const t0 = T0 - 60;
    const t1 = Math.max(...s.timelines.map((tl) => (Number.isFinite(tl.goneAt) ? tl.goneAt : 0))) + 60;

    // 1. 逐秒车身不重叠
    const a = audit(s, t0, t1);
    expect(a.n, a.examples.join(' | ')).toBe(0);

    // 2. 每个门、用到的每种车：路线通过检查（倒车不碰两边门口的车、铰接角、挂车摆正、转弯半径、车头不进待命车道）
    const kinds = new Set(visits.map((v) => v.vehicle));
    for (let d = 0; d < plan.doors.length; d++)
      for (const k of kinds) {
        const ck = checkRoute(plan, yardRoute(plan, d, k));
        expect(ck.problems, `${plan.doors[d]?.id} ${k}`).toEqual([]);
        expect(ck.maxArtic).toBeLessThanOrEqual((65 * Math.PI) / 180);
      }

    const lives = s.timelines.filter((tl) => tl.segs.some((x) => x.kind === 'pullout'));
    // 3. 先进先出：先进待命车道的车先进场
    for (const x of lives) for (const y of lives) if (x.joinAt < y.joinAt) expect(x.enterAt, `${x.visit.id} ${y.visit.id}`).toBeLessThanOrEqual(y.enterAt);

    // 4. 同一区段（和进场通道）同一时间只有一辆车在调车（驶离的车头开出驶出点以后不算：它在进场道路的驶出车道上往外开）
    const byId = new Map(s.timelines.map((tl) => [tl.visit.id, tl] as const));
    for (let t = t0; t <= t1; t += 2) {
      const owner = new Map<string, string>();
      for (const m of unitsAt(s, t).filter((x) => ['enter', 'wait', 'back', 'pullout', 'exit'].includes(x.seg) && !(x.seg === 'exit' && t >= (byId.get(x.id)?.outAt ?? Infinity))))
        for (const res of courtResources(plan, m.u.dims, m.u.pose)) {
          const o = owner.get(res);
          expect(o === undefined || o === m.id, `${t} ${res} ${o} ${m.id}`).toBe(true);
          owner.set(res, m.id);
        }
    }

    // 5. 同一个门不会同时有两辆车（自己靠台的车：开始倒车到拉出转弯；甩挂的挂车：在门口的时段）
    for (let d = 0; d < plan.doors.length; d++) {
      const spans = s.timelines
        .filter((tl) => tl.visit.door === d)
        .map((tl) => {
          const pull = tl.segs.find((x) => x.kind === 'pullout');
          if (pull) return [tl.backAt, pull.t1] as const;
          const dock = tl.segs.find((x) => x.kind === 'docked');
          return dock ? ([dock.t0, dock.t1] as const) : undefined;
        })
        .filter((x): x is readonly [number, number] => !!x)
        .sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < spans.length; i++) expect((spans[i] as readonly [number, number])[0], `门 ${d}`).toBeGreaterThanOrEqual((spans[i - 1] as readonly [number, number])[1] - 1e-6);
    }

    // 6. 时刻语义：到了进场点才进场（到早了先在场外等）；按时或更晚拉出；放得下的车做完（至少一半的）准备、留够最少的装卸；放不下的标 tight
    for (const tl of lives) {
      const v = tl.visit;
      expect(tl.joinAt).toBeGreaterThanOrEqual(v.arrive - 1e-6);
      if (tl.joinAt > v.arrive + 1) expect(tl.segs[0]?.kind).toBe('hold');
      for (let i = 1; i < tl.segs.length; i++) expect((tl.segs[i] as { t0: number }).t0).toBeCloseTo((tl.segs[i - 1] as { t1: number }).t1, 6);
      const pull = tl.segs.find((x) => x.kind === 'pullout') as { t0: number };
      expect(pull.t0).toBeGreaterThanOrEqual(v.leaveAt - 1e-6);
      expect(pull.t0).toBeGreaterThanOrEqual(tl.dockedAt + 60 - 1e-6);
      expect(tl.unloadAt).toBeGreaterThanOrEqual(Math.min(v.dockAt, pull.t0) - 1e-6);
      const d = yardRoute(plan, v.door, v.vehicle).dims;
      const prep = d.kind === 'rig' ? PREP.rig : d.length > 8 ? PREP.truck : PREP.van;
      const work = d.kind === 'rig' ? MIN_WORK.rig : d.length > 8 ? MIN_WORK.truck : MIN_WORK.van;
      if (!tl.tight) {
        expect(tl.unloadAt).toBeGreaterThanOrEqual(tl.dockedAt + prep / 2 - 1e-6);
        expect(pull.t0 - tl.unloadAt).toBeGreaterThanOrEqual(work - 1);
      } else expect(tl.notes.length).toBeGreaterThan(0);
    }
    const tight = s.timelines.filter((tl) => tl.tight).length;
    if (tight) expect(s.notes.some((n) => n.includes(`${tight} 辆车`))).toBe(true);

    // 7. 结果确定：同样的输入（换一个内容相同的布置对象，不走缓存）排出来一样
    const again = scheduleYard(planYard(inputOf(c, { sectionSpan: 70 })), visitsOf(plan, c));
    const sig = (x: YardSchedule) => JSON.stringify(x.timelines.map((tl) => [tl.joinAt, tl.enterAt, tl.backAt, tl.dockedAt, tl.unloadAt, tl.outAt, tl.goneAt, tl.tight, tl.segs]));
    expect(sig(again)).toBe(sig(s));
  });

  it('甩挂车位不够：不和别的挂车挤一个车位，赶不上靠台的改成自己靠台装卸并写明', () => {
    const plan = planYard(inputOf({ doors: 6, rate: 0, drop: true }));
    // 10 个挂车一起来甩、都不来挂走：6 个车位放满以后，后面的改成自己靠台
    const visits: YardVisit[] = Array.from({ length: 10 }, (_, i) => ({ id: `T${i + 1}`, vehicle: 'semi' as const, door: i % 6, arrive: T0 + i * 120, dockAt: T0 + 2400 + i * 900, leaveAt: T0 + 4200 + i * 900, mode: 'drop' as const }));
    const s = scheduleYard(plan, visits);
    const live = s.timelines.filter((tl) => tl.segs.some((x) => x.kind === 'pullout'));
    expect(live.length).toBeGreaterThan(0);
    for (const tl of live) expect(tl.notes.some((n) => n.includes('改成自己靠台装卸'))).toBe(true);
    expect(s.notes.some((n) => n.includes('改成自己靠台装卸'))).toBe(true);
    const t1 = Math.max(...s.timelines.map((tl) => (Number.isFinite(tl.goneAt) ? tl.goneAt : 0)), T0 + 20000);
    const a = audit(s, T0 - 60, t1);
    expect(a.n, a.examples.join(' | ')).toBe(0);
  });
});
