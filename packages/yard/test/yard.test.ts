import { describe, expect, it } from 'vitest';
import {
  angDiff,
  checkPlan,
  addSimVisit,
  checkRoute,
  clearYardSites,
  courtResources,
  defineYardSite,
  findYardDoor,
  footprint,
  ForwardRig,
  minRadius,
  obbIntersects,
  planYard,
  poseAt,
  ReverseRig,
  scheduleYard,
  setSiteVisits,
  shunterRoute,
  simVisitFor,
  simVisitId,
  siteSchedule,
  siteSummary,
  siteTimeline,
  stallRoute,
  toLocal,
  TowChain,
  toWorld,
  yardRoute,
  yardSite,
  yardSites,
  yawOf,
  type PoseUnit,
  type YardInput,
  type YardPlan,
  type YardSchedule,
  type YardVehicle,
  type YardVisit,
} from '../src/index';
import { fillet, quarter } from '../src/geom';
import { lanePose, legPose } from '../src/routes';

/**
 * 收货场 / 月台场地引擎（@storewright/yard）：布置、路线、铰接运动学、排程、甩挂、场地登记。
 * 规则对照第一部分 Storewright 的卸货场（决策记录 0018、0019）：从司机一侧倒车、挂车在离墙 24 米外摆正、
 * 倒车和拉出不碰两边门口的车、场内转弯不小于 12 米、待命车道先进先出、场地里同一时间（同一区段）一辆车调车、驶离优先。
 */
const DEG = Math.PI / 180;
const KINDS: YardVehicle[] = ['semi', 'reefer', 'chassis', 'truck', 'van'];

/** 门从 x = 0 起按间距排；右侧进场时进场道路在最后一个门外 60 米，左侧进场时在第一个门前 80 米 */
function input(n: number, spacing: number, side: 'left' | 'right', from: 'back' | 'front', depth: number, extra: Partial<YardInput> = {}): YardInput {
  const doors = Array.from({ length: n }, (_, i) => i * spacing);
  const maxDoor = doors[doors.length - 1] as number;
  return side === 'right' ? { doors, x0: -90, x1: maxDoor + 60, depth, side, from, ...extra } : { doors, x0: -80, x1: maxDoor + 140, depth, side, from, ...extra };
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

/** 像仿真那样排一天的到货：先到先进、按门空出来的先后分门；靠台时刻留出进场调车的时间 */
function dayVisits(p: YardPlan, n: number, seed: number, start = 3600): YardVisit[] {
  const r = rng(seed);
  const free = p.doors.map(() => 0);
  const out: YardVisit[] = [];
  let t = start;
  for (let i = 0; i < n; i++) {
    t += 240 + r() * 840;
    const u = r();
    const vehicle: YardVehicle = u < 0.45 ? 'semi' : u < 0.65 ? 'reefer' : u < 0.8 ? 'truck' : u < 0.9 ? 'van' : 'chassis';
    let door = 0;
    for (let k = 1; k < free.length; k++) if ((free[k] as number) < (free[door] as number)) door = k;
    const dockAt = Math.max(t + 420, (free[door] as number) + 420);
    const leaveAt = dockAt + (vehicle === 'van' ? 600 : vehicle === 'truck' ? 1200 : 1500 + r() * 1500);
    free[door] = leaveAt + 120;
    out.push({ id: `V${i + 1}`, vehicle, door, arrive: t, dockAt, leaveAt });
  }
  return out;
}

/** 按时间取每辆车（和挂车）的样子；场外等候的车不算 */
function unitsAt(s: YardSchedule, t: number): Array<{ id: string; seg: string; u: PoseUnit }> {
  const out: Array<{ id: string; seg: string; u: PoseUnit }> = [];
  for (const tl of s.timelines) {
    const info = poseAt(tl, t);
    if (!info || info.seg === 'hold') continue;
    for (const u of info.units) out.push({ id: tl.visit.id, seg: info.seg, u });
  }
  return out;
}

describe('场地布置', () => {
  it('车道从墙往外依次排开，待命车位、甩挂车位在场地里，每个门属于一个区段（1–10 个门、门距 3.8–5 米、两侧进场、两种来向、大小进深）', () => {
    for (const n of [1, 2, 4, 6, 10])
      for (const spacing of [3.8, 4.3, 5])
        for (const side of ['left', 'right'] as const)
          for (const from of ['back', 'front'] as const)
            for (const depth of [72, 140]) {
              const p = planYard(input(n, spacing, side, from, depth, { drop: depth > 100 ? 6 : 0 }));
              const tag = `${n}/${spacing}/${side}/${from}/${depth}`;
              expect(checkPlan(p), tag).toEqual([]);
              expect(p.level, tag).toBe(depth > 100 ? 'full' : side === 'right' ? 'compact' : 'court');
              expect(p.z1, tag).toBeLessThanOrEqual(depth + 1e-6);
              expect(p.alignZ, tag).toBeGreaterThanOrEqual(24);
              expect(p.noseLine, tag).toBeCloseTo(0.6 + 16.8, 6);
              if (depth > 100) expect(p.stalls.length, tag).toBeGreaterThan(0);
              // 左侧进场、进深小的只有靠台车道和驶离车道，在进场道路上排队
              if (p.level === 'court') expect(p.queue.slots, tag).toBe(0);
            }
  });

  it('进深不够时退成紧凑布置并写明；甩挂车位要完整布置；车位放不下时按放得下的', () => {
    const r = planYard(input(4, 4.3, 'right', 'back', 62, { drop: 4 }));
    expect(r.level).toBe('compact');
    expect(r.notes.join()).toContain('顶部车道');
    expect(r.notes.join()).toContain('甩挂车位');
    const tight = planYard(input(4, 4.3, 'right', 'back', 30));
    expect(tight.notes.join()).toContain('进深不够');
    const q = planYard({ ...input(4, 4.3, 'right', 'back', 140), x0: -30, queue: 6 });
    expect(q.queue.slots).toBeLessThan(6);
    expect(q.notes.join()).toContain('待命车道只放得下');
  });

  it('长墙分区段：24 个门（门距 4.3 米）分成几段，每段不超过 70 米', () => {
    const p = planYard({ doors: Array.from({ length: 24 }, (_, i) => i * 4.3), x0: -100, x1: 200, depth: 140, side: 'right' });
    expect(p.sections.length).toBeGreaterThan(1);
    for (const s of p.sections) expect(s.x1 - s.x0).toBeLessThanOrEqual(70 + 1e-6);
    expect(new Set(p.doors.map((d) => d.section)).size).toBe(p.sections.length);
  });

  it('要画的东西：车道虚线、行车箭头、门前对位线、待命车位框、甩挂车位框、双黄线和「货车入口」牌；给了路口有喇叭口和停止线', () => {
    const p = planYard(input(4, 4.3, 'right', 'back', 140, { drop: 4, road: { z: -40, half: 7.5 } }));
    const kinds = new Set(p.marks.map((m) => m.kind));
    for (const k of ['line', 'arrow', 'box', 'sign'] as const) expect(kinds.has(k)).toBe(true);
    expect(p.marks.filter((m) => m.kind === 'box').length).toBe(p.queue.slots + p.stalls.length);
    expect(p.marks.some((m) => m.kind === 'sign' && m.text === '货车入口')).toBe(true);
    expect(p.junction?.flares.length).toBe(2);
    // 喇叭口：离拐角最远的点在 15 米处
    const flare = p.junction?.flares[0] ?? [];
    expect(Math.max(...flare.map((q) => q.z)) - (-40 + 7.5)).toBeCloseTo(15, 0);
    expect(p.driveLen).toBeCloseTo(40 - 7.5, 6);
    expect(planYard(input(4, 4.3, 'right', 'back', 140, { access: 'street', road: { z: -40, half: 7.5 } })).junction?.signal).toBe(true);
  });
});

describe('路线：从司机一侧倒车靠台', () => {
  it('每个门、每种车：车道走完和倒车起点接得上，挂车在离墙 24 米外摆正，倒车和拉出不碰两边的车，铰接角 ≤ 65°，车头不进待命车道，转弯半径 ≥ 11.5 米', () => {
    for (const n of [1, 4, 10])
      for (const spacing of [3.8, 5])
        for (const side of ['left', 'right'] as const)
          for (const from of ['back', 'front'] as const)
            for (const depth of [72, 140]) {
              const p = planYard(input(n, spacing, side, from, depth));
              const tag = `${n}/${spacing}/${side}/${from}/${depth}`;
              expect(p.notes.filter((x) => x.includes('找不到') || x.includes('太近')), tag).toEqual([]);
              p.doors.forEach((d, i) => {
                const kinds = i === 0 || i === p.doors.length - 1 ? KINDS : (['semi'] as YardVehicle[]);
                for (const v of kinds) {
                  const r = yardRoute(p, i, v);
                  const ck = checkRoute(p, r);
                  expect(ck.problems, `${tag} ${d.id} ${v}`).toEqual([]);
                  expect(r.ok, `${tag} ${d.id} ${v}`).toBe(true);
                  // 倒车起点：挂车斜着朝 +x、+z（车尾朝墙和门），车头向右（+z）摆出去——从司机一侧（左侧）倒车
                  const b0 = { x: 0, z: 0, heading: 0, trailer: 0, reversing: true, speed: 0, steer: 0 };
                  r.back.rig.poseAt(0, b0);
                  expect(b0.trailer, `${tag} ${v}`).toBeGreaterThan(0.15);
                  expect(b0.trailer, `${tag} ${v}`).toBeLessThan(Math.PI / 2);
                  expect(ck.maxArtic).toBeLessThanOrEqual(65 * DEG);
                  if (r.dims.kind === 'rig') expect(ck.alignedAt, `${tag} ${v}`).toBeGreaterThanOrEqual(24);
                }
              });
            }
  });

  it('待命车位按距离从前到后排开：车停在待命车道上、车头朝 −x、车头对齐车位前沿', () => {
    const p = planYard(input(4, 4.3, 'right', 'back', 140));
    for (const v of ['semi', 'van'] as const) {
      const r = yardRoute(p, 0, v);
      const pose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 };
      for (let j = 0; j < p.queue.slots; j++) {
        const s = r.slotS(j);
        if (j > 0) expect(s).toBeLessThan(r.slotS(j - 1));
        lanePose(r, s, pose);
        expect(pose.z).toBeCloseTo(p.zQueue, 1);
        expect(Math.abs(angDiff(pose.heading, -Math.PI / 2))).toBeLessThan(0.02);
        expect(pose.x - (v === 'semi' ? 4.4 : 4.6)).toBeCloseTo(p.queue.xHead + j * p.queue.pitch, 1);
      }
      // 车位排满以后排在进场道路上
      expect(r.slotS(p.queue.slots + 1)).toBeLessThan(r.slotS(p.queue.slots - 1));
    }
  });

  it('给了路口：从主路拐进、拐出都是 15 / 17 米的圆弧，驶出时在停止线前停车让行', () => {
    const p = planYard(input(4, 4.3, 'right', 'back', 140, { road: { z: -40, half: 7.5 } }));
    for (const [fromLeft, toLeft] of [
      [true, true],
      [false, false],
    ] as const) {
      const r = yardRoute(p, 1, 'semi', { fromLeft, toLeft });
      expect(r.approach).toBeDefined();
      const st = { x: 0, z: 0, heading: 0 };
      const pts: Array<{ x: number; z: number }> = [];
      for (let t = 0; t <= (r.approach?.path.duration ?? 0); t += 0.5) {
        r.approach?.path.at(t, st);
        pts.push({ x: st.x, z: st.z });
      }
      expect(minRadius(pts)).toBeGreaterThan(11.5);
      // 驶出：有一段停着（让行），然后上主路
      let stopped = 0;
      const ex = { x: 0, z: 0, heading: 0, speed: 0 };
      for (let t = 0; t <= r.exit.path.duration; t += 0.5) {
        r.exit.path.at(t, ex);
        if ((ex.speed ?? 0) < 0.01 && t > 5) stopped += 0.5;
      }
      expect(stopped).toBeGreaterThanOrEqual(4);
      r.exit.path.at(r.exit.path.duration, ex);
      expect(Math.abs(ex.z - (-40 + (toLeft ? -1 : 1) * 3.5))).toBeLessThan(0.5);
    }
  });
});

describe('铰接运动学', () => {
  it('前进转弯时挂车切内侧，出弯后慢慢摆正', () => {
    const a = { x: 0, z: 0 };
    const pts = [a, { x: 30, z: 0 }, ...quarter({ x: 30, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 1 }, 13), { x: 43, z: 13 + 40 }];
    const rig = new ForwardRig(pts, 9.5);
    const center = { x: 30, z: 13 };
    const p = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 };
    let minAxle = Infinity;
    for (let s = 0; s <= rig.length; s += 0.5) {
      rig.poseAt(s, p);
      const ax = { x: p.x - 9.5 * Math.sin(p.trailer), z: p.z - 9.5 * Math.cos(p.trailer) };
      if (p.x > 30 && p.z < 13) minAxle = Math.min(minAxle, Math.hypot(ax.x - center.x, ax.z - center.z));
    }
    expect(minAxle).toBeLessThan(13 - 2);
    rig.poseAt(rig.length, p);
    expect(Math.abs(angDiff(p.trailer, p.heading))).toBeLessThan(2 * DEG);
  });

  it('倒车：挂车朝向是行进方向的反方向，牵引销在车轴前方 L 处；起步从前进结束时牵引车的朝向平滑过渡', () => {
    const axle = [{ x: 20, z: 30 }, { x: 10, z: 25 }, ...fillet([{ x: 10, z: 25 }, { x: 0, z: 20 }, { x: 0, z: 2 }], 8).slice(1)];
    const rr = new ReverseRig(axle, 9.5, 1.2);
    const p = { x: 0, z: 0, heading: 0, trailer: 0, reversing: true, speed: 0, steer: 0 };
    rr.poseAt(0, p);
    expect(p.heading).toBeCloseTo(1.2, 6);
    for (let s = 0; s <= rr.length; s += 1) {
      rr.poseAt(s, p);
      const ax = { x: p.x - 9.5 * Math.sin(p.trailer), z: p.z - 9.5 * Math.cos(p.trailer) };
      const q = rr.line.point(s);
      expect(Math.hypot(ax.x - q.x, ax.z - q.z)).toBeLessThan(0.05);
    }
    rr.poseAt(rr.length, p);
    expect(Math.abs(angDiff(p.trailer, 0))).toBeLessThan(0.01);
    expect(Math.abs(angDiff(p.heading, p.trailer))).toBeLessThan(0.05);
  });

  it('拖车串（机场牵引车拖 3 节板车）：每一节的车轴到挂点的距离不变，跟着前一节走', () => {
    const lead = fillet([{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 40, z: 30 }, { x: 0, z: 30 }], 10);
    const units = [
      { hitch: 1.2, length: 2.6 },
      { hitch: 1.4, length: 2.6 },
      { hitch: 1.4, length: 2.6 },
    ];
    const chain = new TowChain(lead, units);
    const L = { x: 0, z: 0, heading: 0 };
    const us = [{ x: 0, z: 0, heading: 0 }];
    for (let s = 0; s <= chain.length; s += 1) {
      chain.at(s, L, us);
      let px = L.x;
      let pz = L.z;
      let ph = L.heading;
      units.forEach((u, i) => {
        const o = us[i] as { x: number; z: number; heading: number };
        const hx = px - u.hitch * Math.sin(ph);
        const hz = pz - u.hitch * Math.cos(ph);
        expect(Math.hypot(hx - o.x, hz - o.z)).toBeCloseTo(u.length, 3);
        px = o.x;
        pz = o.z;
        ph = o.heading;
      });
    }
  });

  it('朝向换算：yawOf 和 three.js 的 yaw（车模车头朝 +x，atan2(−dz, dx)）一致；本地 ↔ 区域坐标来回不变', () => {
    for (const h of [0, 0.7, Math.PI / 2, 2.5, -1.2]) {
      const dir = { x: Math.sin(h), z: Math.cos(h) };
      const want = Math.atan2(-dir.z, dir.x);
      expect(Math.abs(angDiff(yawOf(undefined, h), want))).toBeLessThan(1e-9);
      const f = { origin: { x: 120, z: -45 }, yaw: 0.6 };
      const w0 = toWorld(f, { x: 0, z: 0 });
      const w1 = toWorld(f, dir);
      expect(Math.abs(angDiff(yawOf(f, h), Math.atan2(-(w1.z - w0.z), w1.x - w0.x)))).toBeLessThan(1e-9);
      const back = toLocal(f, toWorld(f, { x: 7, z: -3 }));
      expect(back.x).toBeCloseTo(7, 9);
      expect(back.z).toBeCloseTo(-3, 9);
    }
  });
});

describe('排程：按仿真的时刻排场内动作', () => {
  const p = planYard(input(4, 14, 'right', 'back', 140));
  const visits = dayVisits(p, 24, 7);
  const s = scheduleYard(p, visits);

  it('先进先出：待命车道里不超车；同一时间同一区段只有一辆车在调车；车与车不相碰', () => {
    const lane = s.timelines.filter((tl) => tl.segs.some((x) => x.kind === 'queue' || x.kind === 'approach'));
    for (const a of lane) for (const b of lane) if (a.joinAt < b.joinAt) expect(a.enterAt, `${a.visit.id} ${b.visit.id}`).toBeLessThanOrEqual(b.enterAt);
    const t0 = Math.min(...visits.map((v) => v.arrive));
    const t1 = Math.max(...s.timelines.map((tl) => tl.goneAt));
    let checked = 0;
    for (let t = t0; t <= t1; t += 1) {
      const us = unitsAt(s, t);
      const moving = us.filter((x) => ['enter', 'wait', 'back', 'pullout', 'exit'].includes(x.seg));
      const owner = new Map<string, string>();
      for (const m of moving)
        for (const res of courtResources(p, m.u.dims, m.u.pose)) {
          const o = owner.get(res);
          expect(o === undefined || o === m.id, `${t} ${res} ${o} ${m.id}`).toBe(true);
          owner.set(res, m.id);
        }
      for (let i = 0; i < us.length; i++)
        for (let j = i + 1; j < us.length; j++) {
          const a = us[i] as (typeof us)[number];
          const b = us[j] as (typeof us)[number];
          if (a.id === b.id) continue;
          checked++;
          for (const fa of footprint(a.u.dims, a.u.pose)) for (const fb of footprint(b.u.dims, b.u.pose)) expect(obbIntersects(fa, fb), `${t} ${a.id}:${a.seg} ${b.id}:${b.seg}`).toBe(false);
        }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('时刻以仿真为准：靠稳并做完（至少一半的）准备再开始装卸，按时拉出；同一个门不会同时停两辆车', () => {
    const ok = s.timelines.filter((tl) => !tl.tight);
    expect(ok.length).toBeGreaterThanOrEqual(Math.ceil(visits.length * 0.75));
    for (const tl of ok) {
      // 仿真的靠台时刻是期望：开始装卸不早于它、也不早于靠稳并做完准备；拉出不早于仿真的离开时刻，之前至少留出最少的装卸时间
      expect(tl.unloadAt).toBeGreaterThanOrEqual(tl.dockedAt + 89);
      expect(tl.unloadAt).toBeGreaterThanOrEqual(Math.min(tl.visit.dockAt, tl.visit.leaveAt) - 1e-6);
      const pull = tl.segs.find((x) => x.kind === 'pullout');
      expect(pull?.t0).toBeGreaterThanOrEqual(tl.visit.leaveAt - 1e-6);
      expect((pull?.t0 ?? 0) - tl.unloadAt).toBeGreaterThanOrEqual(119);
    }
    expect(s.timelines.filter((tl) => tl.lateExit === 0).length).toBeGreaterThanOrEqual(Math.ceil(visits.length * 0.8));
    for (let d = 0; d < p.doors.length; d++) {
      const spans = s.timelines.filter((tl) => tl.visit.door === d).map((tl) => [tl.backAt, tl.segs.find((x) => x.kind === 'pullout')?.t1 ?? tl.goneAt] as const);
      spans.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < spans.length; i++) expect((spans[i] as readonly [number, number])[0]).toBeGreaterThanOrEqual((spans[i - 1] as readonly [number, number])[1] - 1e-6);
    }
    // 段首尾相接
    for (const tl of s.timelines) for (let i = 1; i < tl.segs.length; i++) expect((tl.segs[i] as { t0: number }).t0).toBeCloseTo((tl.segs[i - 1] as { t1: number }).t1, 6);
  });

  it('结果是确定的', () => {
    const again = scheduleYard(p, visits);
    expect(again.timelines.map((tl) => [tl.joinAt, tl.enterAt, tl.dockedAt, tl.goneAt])).toEqual(s.timelines.map((tl) => [tl.joinAt, tl.enterAt, tl.dockedAt, tl.goneAt]));
  });

  it('停留放不下进场、倒车、准备和最少的装卸才标 tight；后到的车门一时空不出来时先在场外等，不堵待命车道', () => {
    const v: YardVisit[] = [
      { id: 'A', vehicle: 'semi', door: 0, arrive: 1000, dockAt: 1060, leaveAt: 1250 },
      { id: 'B', vehicle: 'semi', door: 0, arrive: 1010, dockAt: 4000, leaveAt: 5000 },
      { id: 'C', vehicle: 'van', door: 2, arrive: 1100, dockAt: 1500, leaveAt: 1900 },
    ];
    const r = scheduleYard(p, v);
    const [a, b, c] = r.timelines as [YardSchedule['timelines'][number], YardSchedule['timelines'][number], YardSchedule['timelines'][number]];
    expect(a.tight).toBe(true);
    expect(a.lateDock).toBeGreaterThan(0);
    expect(b.segs[0]?.kind).toBe('hold');
    expect(c.tight).toBe(false);
    expect(c.enterAt).toBeLessThan(b.enterAt);
  });

  it('长墙（24 个门、几个区段）：不同区段可以同时调车，车与车仍然不相碰', () => {
    const q = planYard({ doors: Array.from({ length: 24 }, (_, i) => i * 4.3), x0: -100, x1: 200, depth: 140, side: 'right' });
    const vs = dayVisits(q, 30, 11).map((v, i) => ({ ...v, door: (i * 7) % 24 }));
    const sch = scheduleYard(q, vs);
    let concurrent = 0;
    const t0 = Math.min(...vs.map((v) => v.arrive));
    const t1 = Math.max(...sch.timelines.map((tl) => tl.goneAt));
    for (let t = t0; t <= t1; t += 2) {
      const us = unitsAt(sch, t);
      if (us.filter((x) => ['enter', 'back', 'pullout'].includes(x.seg)).length > 1) concurrent++;
      for (let i = 0; i < us.length; i++)
        for (let j = i + 1; j < us.length; j++) {
          const a = us[i] as (typeof us)[number];
          const b = us[j] as (typeof us)[number];
          if (a.id === b.id) continue;
          for (const fa of footprint(a.u.dims, a.u.pose)) for (const fb of footprint(b.u.dims, b.u.pose)) expect(obbIntersects(fa, fb), `${t} ${a.id}:${a.seg} ${b.id}:${b.seg}`).toBe(false);
        }
    }
    expect(concurrent).toBeGreaterThan(0);
  });
});

describe('甩挂（drop-and-hook）', () => {
  const doors = Array.from({ length: 24 }, (_, i) => -60 + i * 4.3);
  const p = planYard({ doors, x0: -160, x1: 120, depth: 140, side: 'right', drop: 10 });

  it('甩挂车位在顶部车道外侧；有甩挂车位时待命车道当通道（不画待命车位）', () => {
    expect(p.level).toBe('full');
    expect(p.stalls.length).toBe(10);
    expect(p.queue.slots).toBe(0);
    for (const st of p.stalls) expect(st.z).toBeGreaterThan(p.zTop);
  });

  it('公路牵引车甩挂、取挂，场内牵引车车位 → 门、门 → 车位的路线都通过检查', () => {
    for (const k of [0, 4, 9]) {
      expect(stallRoute(p, k, 'semi', 'drop').ok).toBe(true);
      expect(stallRoute(p, k, 'reefer', 'hook').ok).toBe(true);
      for (const d of [0, 11, 23]) {
        const a = shunterRoute(p, k, d, 'toDoor');
        const b = shunterRoute(p, k, d, 'toStall');
        expect(a.ok, `${k}→${d}`).toBe(true);
        expect(b.ok, `${d}→${k}`).toBe(true);
        // 倒进门：最后挂车正对门、车尾离墙约 0.6 米
        const last = a.legs[a.legs.length - 1];
        const pose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: true, speed: 0, steer: 0 };
        if (last) legPose(last, last.path.duration, pose);
        expect(Math.abs(angDiff(pose.trailer, 0))).toBeLessThan(0.03);
        expect(pose.x).toBeCloseTo(doors[d] as number, 1);
      }
    }
  });

  it('排程：甩下 → 场内牵引车在 dockAt 前拖到门 → leaveAt 后拖回车位 → 空车来挂走；挂车和车不相碰', () => {
    const v: YardVisit[] = [
      { id: 'T1', vehicle: 'semi', door: 3, arrive: 3600, dockAt: 7200, leaveAt: 9000, mode: 'drop', pickupAt: 12000 },
      { id: 'T2', vehicle: 'reefer', door: 10, arrive: 3700, dockAt: 6000, leaveAt: 7000, mode: 'drop' },
      { id: 'H1', vehicle: 'semi', door: 20, arrive: 10000, dockAt: 7000, leaveAt: 9500, mode: 'hook' },
      { id: 'L1', vehicle: 'semi', door: 15, arrive: 5000, dockAt: 5600, leaveAt: 7600 },
    ];
    const s = scheduleYard(p, v);
    for (const tl of s.timelines) expect(tl.tight, tl.visit.id).toBe(false);
    for (const tl of s.timelines.slice(0, 3)) {
      const docked = tl.segs.find((x) => x.kind === 'docked');
      expect(docked?.t0).toBeLessThanOrEqual(tl.visit.dockAt);
      expect(docked?.t1).toBeGreaterThanOrEqual(tl.visit.leaveAt - 1e-6);
    }
    expect(s.shunts.length).toBe(6);
    const hook = s.timelines[0]?.segs.find((x) => x.kind === 'hook');
    expect(hook?.t0).toBeGreaterThanOrEqual(12000);
    // 甩下以后、拖去门以前，挂车停在车位里
    expect(poseAt(s.timelines[0] as YardSchedule['timelines'][number], 5000)?.seg).toBe('pool');
    for (let t = 3500; t <= 12500; t += 1) {
      const us = unitsAt(s, t);
      for (let i = 0; i < us.length; i++)
        for (let j = i + 1; j < us.length; j++) {
          const a = us[i] as (typeof us)[number];
          const b = us[j] as (typeof us)[number];
          if (a.id === b.id) continue;
          for (const fa of footprint(a.u.dims, a.u.pose)) for (const fb of footprint(b.u.dims, b.u.pose)) expect(obbIntersects(fa, fb), `${t} ${a.id}:${a.seg} ${b.id}:${b.seg}`).toBe(false);
        }
    }
  });
});

describe('场地登记', () => {
  it('登记、按键和门编号查找、清空', () => {
    clearYardSites();
    const plan = planYard(input(4, 14, 'right', 'back', 140));
    defineYardSite({ key: 'store', frame: { origin: { x: 500, z: -200 }, yaw: 0.4 }, plan, doors: plan.doors.map((d, i) => ({ id: `收货口${i + 1}`, index: i })) });
    defineYardSite({ key: 'dc-dry', frame: { origin: { x: 0, z: 0 }, yaw: 0 }, plan, doors: [{ id: 'C05', index: 1, kinds: ['semi'] }] });
    expect(yardSites().map((s) => s.key)).toEqual(['store', 'dc-dry']);
    expect(yardSite('store')?.frame.yaw).toBe(0.4);
    expect(findYardDoor('C05')?.site.key).toBe('dc-dry');
    expect(findYardDoor('收货口3')?.door.index).toBe(2);
    expect(findYardDoor('X')).toBeUndefined();
    clearYardSites();
    expect(yardSites()).toEqual([]);
  });

  it('场地的排程：场地登记的优先，运动规划补没登记的；同一次停靠的别的编号也算登记了；访问变了才重算', () => {
    clearYardSites();
    const plan = planYard(input(4, 14, 'right', 'back', 140));
    defineYardSite({ key: 'y', frame: { origin: { x: 0, z: 0 }, yaw: 0 }, plan, doors: plan.doors.map((d, i) => ({ id: d.id, index: i })) });
    const a = simVisitFor('y', 7, 2, 'semi', 1, 10000, 13000) as YardVisit;
    expect(a.id).toBe(simVisitId(7, 2));
    expect(a.arrive).toBe(10000);
    const r = yardRoute(plan, 1, 'semi');
    expect(a.leaveAt).toBeCloseTo(13000 - r.exit.tGate, 6);
    // 只有运动规划补的：排得出，车头在仿真的离开时刻开到驶出点
    addSimVisit('y', a, [simVisitId(7, 3)]);
    const tl = siteTimeline('y', a.id);
    expect(tl?.tight).toBe(false);
    expect(tl?.outAt).toBeCloseTo(13000, 6);
    const s0 = siteSchedule('y');
    expect(siteSchedule('y')).toBe(s0);
    // 场地按同一次停靠的另一段登记：不再补，只有场地登记的这一条
    setSiteVisits('y', [{ ...a, id: simVisitId(7, 3), arrive: 10600 }]);
    expect(siteSchedule('y')?.timelines.map((x) => x.visit.id)).toEqual([simVisitId(7, 3)]);
    expect(siteTimeline('y', a.id)).toBeUndefined();
    const sum = siteSummary('y');
    expect(sum?.visits).toBe(1);
    clearYardSites();
  });
});
