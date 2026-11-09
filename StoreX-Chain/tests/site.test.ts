import { beforeAll, describe, expect, it } from 'vitest';
import { runDay } from '../../StoreX/src/ops/day';
import type { AgentTrace } from '../../StoreX/src/ops/trace';
import { gen1, storex } from '../../StoreX/src/world/config';
import { HUB_SLOT } from '../src/hub/types';
import { ACCESS_AISLE, buildStoreLot, FIRE_LANE, SPOT_D, SPOT_W, WALK, type Stall, type StoreLot } from '../src/site/lot';
import { siteOps } from '../src/site/ops';
import { GET_OUT, LOAD, planStays, WALK_SPEED, type StayPlan } from '../src/site/stays';
import { jobFromBoard, storeTruckVisits, yardTurns, type TruckVisit } from '../src/site/trucks';
import { deriveVisits, isLong, isPickup, type CarVisit } from '../src/site/visits';
import { DEFAULT_REGION } from '../src/region/regionGen';
import { setRegion } from '../src/region/network';
import type { WVehicle } from '../src/sim/trace';
import { layoutCity } from '../web/src/three/cityplan';
import { RoadNet } from '../web/src/three/roadnet';
import { DESIGN_PEAK, EXT, PARK_RATIO, type Site } from '../web/src/three/stores';
import { findYardDoor, rearOf, toWorld, yardRoute, yardSite } from '@storewright/yard';

/**
 * 综合店站点：停车场的布置（尺寸、无障碍车位、消防车道、配建）、车位安排（同一车位不重叠、长车位占着的车位不停别的车、
 * 取货的车照门店仿真的时刻停、免下车车道不超车）、出场让行、值班助手的数据和车位安排一致、收货场登记给区域。
 */
const lotOf = (rows = 2) => buildStoreLot({ front: 21, storeX0: -36, storeX1: 35, doors: { entrance: { x: -9.5, z: 22 }, exit: { x: 2.5, z: 22 } }, rows });

let agents: { storex: readonly AgentTrace[]; gen1: readonly AgentTrace[] };
beforeAll(() => {
  const run = (s: ReturnType<typeof storex>) => {
    s.trace = true;
    return runDay(s).trace?.agents ?? [];
  };
  agents = { storex: run(storex(1)), gen1: run(gen1(1)) };
});

describe('店前停车场的布置', () => {
  it('车位、车道、消防车道、无障碍车位按公开资料取的尺寸', () => {
    const lot = lotOf();
    const front = lot.frontStalls.map((i) => lot.stalls[i] as Stall);
    expect(front.every((s) => s.w >= 2.4 && s.d >= 5.3)).toBe(true);
    expect(SPOT_W).toBeGreaterThanOrEqual(2.4);
    expect(SPOT_D).toBeGreaterThanOrEqual(5.3);
    // 消防车道：宽不小于 4 米，离店房外墙不小于 5 米
    expect(lot.fireLane[1] - lot.fireLane[0]).toBeGreaterThanOrEqual(4);
    expect(lot.fireLane[0] - lot.front).toBeGreaterThanOrEqual(5);
    expect(WALK).toBeGreaterThanOrEqual(5);
    expect(FIRE_LANE).toBeGreaterThanOrEqual(4);
    // 无障碍车位不少于 1%，每个旁边有 1.2 米宽的斜线通道，在店门附近
    const acc = front.filter((s) => s.kind === 'accessible');
    expect(acc.length).toBeGreaterThanOrEqual(Math.max(1, Math.ceil(front.length / 100)));
    for (const s of acc) {
      expect(lot.hatches.some((h) => Math.abs(h.z - s.z) < 0.1 && Math.abs(Math.abs(h.x - s.x) - (ACCESS_AISLE / 2 + SPOT_W / 2)) < 0.05)).toBe(true);
      expect(Math.abs(s.x - lot.doors.entrance.x)).toBeLessThan(25);
    }
    // 车位互不重叠（店前、取货区）
    const all = lot.stalls;
    for (let i = 0; i < all.length; i++)
      for (let k = i + 1; k < all.length; k++) {
        const a = all[i] as Stall;
        const b = all[k] as Stall;
        const wa = Math.abs(Math.sin(a.heading)) > 0.5 ? a.d : a.w;
        const da = Math.abs(Math.sin(a.heading)) > 0.5 ? a.w : a.d;
        const wb = Math.abs(Math.sin(b.heading)) > 0.5 ? b.d : b.w;
        const db = Math.abs(Math.sin(b.heading)) > 0.5 ? b.w : b.d;
        const overlap = Math.abs(a.x - b.x) < (wa + wb) / 2 - 0.01 && Math.abs(a.z - b.z) < (da + db) / 2 - 0.01;
        expect(overlap, `${i} ${k}`).toBe(false);
      }
    // 长车位在最远一排靠路的半排两头，占 8 个车位
    expect(lot.long.length).toBe(2);
    for (const b of lot.long) expect(b.spots.length).toBe(8);
  });

  it('车位数按建筑面积的配建指标和设计高峰小时的车（留 15% 余量）', () => {
    const area = 71 * 52 + (EXT.x1 - EXT.x0) * (EXT.z1 - EXT.z0);
    const need = Math.max((PARK_RATIO * area) / 100, DESIGN_PEAK / 0.85);
    for (const rows of [1, 2, 3, 4]) {
      const lot = lotOf(rows);
      expect(lot.frontStalls.length).toBeGreaterThan(rows * 50);
    }
    expect(lotOf(2).frontStalls.length).toBeGreaterThanOrEqual(need);
  });
});

describe('车位安排', () => {
  const check = (lot: StoreLot, visits: CarVisit[], plan: StayPlan) => {
    // 同一个车位的占用时段不重叠
    for (const [, list] of plan.byStall) for (let k = 1; k < list.length; k++) expect((list[k] as [number, number])[0]).toBeGreaterThanOrEqual((list[k - 1] as [number, number])[1] - 1e-6);
    // 长车位占着的车位那段时间没有别的车
    for (const st of plan.stays.filter((s) => s.mode === 'long')) {
      for (const c of st.covers ?? []) {
        const others = plan.stays.filter((o) => o !== st && o.mode !== 'long' && o.mode !== 'drive' && o.stall === c && o.arrive < st.leave && st.arrive < o.leave);
        expect(others.length).toBe(0);
      }
    }
    // 取货的车照门店仿真的时刻停（免下车取货照到达车道口的时刻），交付完才走
    for (const st of plan.stays.filter((s) => isPickup(s.visit.kind))) {
      if (st.mode === 'drive') expect(st.enter).toBe(st.visit.arrive);
      else expect(st.arrive).toBe(st.visit.arrive);
      expect(st.leave).toBeGreaterThanOrEqual(st.visit.leave - 1e-6);
    }
    // 购物的车在顾客进门之前停好、顾客走回来装完车才开走
    for (const st of plan.stays.filter((s) => (s.visit.kind === 'shopper' || s.visit.kind === 'dept') && s.walk !== undefined)) {
      expect(st.arrive + GET_OUT + (st.walk as number) - 1e-6).toBeLessThanOrEqual(st.visit.enter as number);
      expect(st.leave + 1e-6).toBeGreaterThanOrEqual((st.visit.exit as number) + (st.walk as number) + LOAD);
    }
    // 免下车取货车道不超车：后进来的车停在前面车的后面（北边），前面的车走了才走
    const drive = plan.stays.filter((s) => s.mode === 'drive').sort((a, b) => a.arrive - b.arrive);
    for (let i = 0; i < drive.length; i++)
      for (let k = 0; k < i; k++) {
        const a = drive[k] as (typeof drive)[number];
        const b = drive[i] as (typeof drive)[number];
        if (a.leave <= b.arrive) continue;
        expect(b.drive?.[0]?.pos ?? b.stall).toBeLessThan(a.stall);
        expect(b.leave).toBeGreaterThanOrEqual(a.leave);
      }
    // 停车比例：倒车入位约 12%、穿过停约 8%（只算普通车位上的购物车）
    const shop = plan.stays.filter((s) => (s.visit.kind === 'shopper' || s.visit.kind === 'dept') && (lot.stalls[s.stall] as Stall).kind === 'general');
    const back = shop.filter((s) => s.mode === 'back').length / shop.length;
    const through = shop.filter((s) => s.mode === 'through').length / shop.length;
    expect(back).toBeGreaterThan(0.08);
    expect(back).toBeLessThan(0.16);
    expect(through).toBeGreaterThan(0.02);
    expect(through).toBeLessThan(0.1);
    // 越靠店门越满：最近的一圈车位比最远的一圈停的时间长
    const front = lot.frontStalls.filter((i) => !plan.staffStalls.has(i)).map((i) => lot.stalls[i] as Stall);
    const busy = (s: Stall) => (plan.byStall.get(s.i) ?? []).reduce((a, [x, y]) => a + (y - x), 0);
    const byDist = [...front].sort((a, b) => Math.abs(a.x - lot.walkX) + a.z - (Math.abs(b.x - lot.walkX) + b.z));
    const n = Math.floor(byDist.length / 4);
    const near = byDist.slice(0, n).reduce((a, s) => a + busy(s), 0);
    const far = byDist.slice(-n).reduce((a, s) => a + busy(s), 0);
    expect(near).toBeGreaterThan(far);
    expect(visits.length).toBeGreaterThan(1500);
  };

  it('StoreX：自提柜、免下车取货、购物、员工、长车', () => {
    const lot = lotOf();
    const visits = deriveVisits(agents.storex, { seed: 1, generation: 'storex' });
    expect(visits.some((v) => v.kind === 'locker')).toBe(true);
    expect(visits.some((v) => v.kind === 'drive')).toBe(true);
    expect(visits.some((v) => isLong(v.kind))).toBe(true);
    const plan = planStays(lot, visits, 1);
    check(lot, visits, plan);
    expect(plan.turnedAway.length).toBeLessThanOrEqual(2);
  });

  it('上一代：车边交付', () => {
    const lot = lotOf();
    const visits = deriveVisits(agents.gen1, { seed: 3, generation: 'gen1' });
    expect(visits.filter((v) => v.kind === 'pickup').length).toBeGreaterThan(100);
    const plan = planStays(lot, visits, 3);
    check(lot, visits, plan);
  });
});

describe('值班助手的数据（门店的停车场、即时取货、收货场）', () => {
  it('指标和每辆车的流水一致', () => {
    const lot = lotOf();
    const visits = deriveVisits(agents.storex, { seed: 1, generation: 'storex' });
    const plan = planStays(lot, visits, 1);
    const trucks: TruckVisit[] = [
      { vid: 1, label: '配送车 A', kind: 'truck', type: 'semi', dock: 0, seg: 2, job: 'M01', arrive: 3600 * 6, dockAt: 3600 * 6 + 100, leaveAt: 3600 * 6.6, pallets: 20 },
      { vid: 2, label: '配送车 B', kind: 'reefer', type: 'reefer', dock: 0, seg: 2, job: 'M02', arrive: 3600 * 6.1, dockAt: 3600 * 6.1 + 100, leaveAt: 3600 * 6.7, pallets: 18 },
      { vid: 3, label: '直送车', kind: 'truck', type: 'semi', dock: 1, seg: 1, arrive: 3600 * 9, dockAt: 3600 * 9 + 90, leaveAt: 3600 * 9.5, pallets: 26 },
    ];
    const turns = yardTurns(trucks);
    // 同一个收货口：第二辆等第一辆拉出才进场
    expect((turns[1] as (typeof turns)[number]).queue[1]).toBeGreaterThan((turns[0] as (typeof turns)[number]).door[1] - 1);
    const hub = siteOps({ lot, plan, turns, docks: 4, queueSlots: 4, generation: 'storex' });
    expect(hub.key).toBe('store');
    const kpi = (k: string) => (hub.kpi.find((x) => x.key === k) as { value: number }).value;
    const waits = plan.stays.filter((s) => isPickup(s.visit.kind)).map((s) => ((s.visit.handoff as number) - (s.enter ?? s.arrive)) / 60);
    expect(kpi('pickupMean')).toBeCloseTo(waits.reduce((a, b) => a + b, 0) / waits.length, 6);
    expect(kpi('pickupCars')).toBe(waits.length);
    expect(kpi('trucks')).toBe(3);
    expect(kpi('yardQueue')).toBe(1);
    // 普通车位的占用：随便挑几个时刻，5 分钟格的平均数和数出来的车数差不多
    const frontSet = new Set(lot.frontStalls.filter((i) => !plan.staffStalls.has(i)));
    for (const h of [10, 12.5, 17.75]) {
      const k = Math.floor((h * 3600) / HUB_SLOT);
      const t0 = k * HUB_SLOT;
      let sum = 0;
      for (const st of plan.stays) {
        if (st.mode === 'long' || st.mode === 'drive' || !frontSet.has(st.stall)) continue;
        sum += Math.max(0, Math.min(st.leave, t0 + HUB_SLOT) - Math.max(st.arrive, t0)) / HUB_SLOT;
      }
      expect((hub.occupancy.front as Float32Array)[k]).toBeCloseTo(sum, 3);
    }
    // 仿真的车写调度台的作业编号，冷藏车标冷链
    const fl = hub.flows.filter((f) => f.id.startsWith('T'));
    expect(fl.map((f) => f.carrierIn)).toEqual(['M01', 'M02', '直送车']);
    expect(fl.map((f) => f.cold)).toEqual([false, true, false]);
    expect(hub.flows.every((f) => f.kind === 'vehicle')).toBe(true);
    expect(hub.notes.length).toBeGreaterThan(1);
    expect(WALK_SPEED).toBeGreaterThan(1);
  });

  it('调度台的作业编号按到店时刻挑那一趟', () => {
    const job = jobFromBoard([{ id: 'A', vehicle: 1, stops: [{ key: 'S', arrive: 100 }] }, { id: 'B', vehicle: 1, stops: [{ key: 'S', arrive: 900 }] }, { id: 'C', vehicle: 2, stops: [{ key: 'X', arrive: 900 }] }], 'S');
    expect(job(1, 880)).toBe('B');
    expect(job(1, 120)).toBe('A');
    expect(job(2, 900)).toBeUndefined();
  });

  it('到门店卸货的车按调度台排的收货口取', () => {
    const v: WVehicle = { id: 7, kind: 'reefer', label: '多温区配送车', segs: [
      { t0: 0, t1: 100, pts: [0, 0, 1, 1], route: ['DC', 'S01'] },
      { t0: 100, t1: 1300, pts: [1, 1], place: 'S01' },
      { t0: 1300, t1: 1500, pts: [1, 1, 0, 0], route: ['S01', 'DC'] },
    ] };
    const out = storeTruckVisits([v], 'S01', 4, () => 'S01#3', undefined, () => 12, () => 'M07');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ vid: 7, dock: 2, type: 'reefer', seg: 1, job: 'M07', arrive: 100, leaveAt: 1300, pallets: 12 });
    expect((out[0] as TruckVisit).dockAt).toBeCloseTo(100 + Math.min(100, 1200 * 0.35));
  });
});

describe('站点放进区域', () => {
  let site: Site;
  let net: RoadNet;
  beforeAll(() => {
    setRegion(DEFAULT_REGION);
    net = new RoadNet();
    const city = layoutCity(net);
    site = [...city.sites.values()][0] as Site;
  });

  it('货车通道从进店路分出去，收货场登记给区域（默认区域是完整布置）', () => {
    expect(site.truck).toBeDefined();
    expect(net.junctions.get(`${site.st.key}:truck`)).toBeDefined();
    const ys = yardSite(site.st.key);
    expect(ys?.plan.level).toBe('full');
    expect(ys?.plan.queue.slots).toBeGreaterThanOrEqual(2);
    expect(ys?.doors.map((d) => d.id)).toEqual([site.st.key, ...Array.from({ length: (ys?.doors.length ?? 1) - 1 }, (_, k) => `${site.st.key}#${k + 2}`)]);
    // 门店这条仿真的边到分岔点为止：货车从这里拐进货车通道
    const arcs = net.edgeArcs.get(`${site.st.node}|${site.st.key}`) ?? [];
    expect(arcs[arcs.length - 1]?.jb).toBe(`${site.st.key}:truck`);
    // 收货口的停靠点从分岔点起，走的时候沿驶离车道回分岔点
    const p = net.places.get(site.st.key) as { path: { x: number; z: number }[]; exit?: { x: number; z: number }[] };
    const tj = net.junctions.get(`${site.st.key}:truck`)?.pos as { x: number; z: number };
    expect(Math.hypot((p.path[0] as { x: number }).x - tj.x, (p.path[0] as { z: number }).z - tj.z)).toBeLessThan(6);
    const last = p.exit?.[p.exit.length - 1] as { x: number; z: number };
    expect(Math.hypot(last.x - tj.x, last.z - tj.z)).toBeLessThan(6);
  });

  it('每个收货口靠稳时车尾贴着门（收货场的坐标系和门店对得上），货车通道 9 米宽、不进顾客的停车场', () => {
    const ys = yardSite(site.st.key);
    expect(ys).toBeDefined();
    if (!ys) return;
    site.docks.forEach((d, k) => {
      const id = k ? `${site.st.key}#${k + 1}` : site.st.key;
      expect(findYardDoor(id)?.door.index).toBe(k);
      for (const v of ['semi', 'reefer', 'truck', 'van'] as const) {
        const r = yardRoute(ys.plan, k, v);
        expect(r.ok, `${id} ${v}`).toBe(true);
        const rear = toWorld(ys.frame, rearOf(v, r.parked));
        expect(Math.hypot(rear.x - d.door.x, rear.z - d.door.z), `${id} ${v}`).toBeLessThan(1.5);
      }
    });
    const line = net.lines[site.truck?.line as number];
    expect((line?.xs.laneW ?? 0) * 2).toBeCloseTo(9);
    for (const p of site.truck?.pts ?? []) expect(p.x < site.lot.x1 && p.z > site.lot.frontZ && p.z < site.lot.edgeZ).toBe(false);
  });

  it('停车场里的车不重叠、给斑马线上的人让行（平常和极限负荷的一整天）；取货的车照时刻，出场停车线前让行，一路不跳', async () => {
    const { planSiteTraffic, lotConflicts, planPose } = await import('../src/site/motion');
    const access = net.lines[site.access.line] as { trimA: number };
    for (const [label, share] of [['平常', 0.55], ['极限', 1.6]] as const) {
      const visits = deriveVisits(agents.storex, { seed: 1, generation: 'storex', deptShare: share });
      const plan = planStays(site.lot, visits, 1);
      // 和页面上一样：干道路口有信号灯，车从两个方向来（各自的绿灯时才放进来），出去的车等出口方向的绿灯
      const inPhase = plan.stays.map((st) => (Math.floor(Math.abs(st.visit.seed)) % 2) as 0 | 1);
      const road = { zIn: site.access.attachZ - (access.trimA + 4), zStop: site.access.attachZ - (access.trimA + 6.6), speed: 4, signal: { offset: 7, inPhase, outPhase: 1 as const } };
      // 人和车流一起排：停不进原来车位、晚过顾客下车走开的车换车位，顾客的路按新车位重排
      const t0 = performance.now();
      const { people, res: lt } = planSiteTraffic(site.lot, plan, 1, road);
      const ms = Math.round(performance.now() - t0);
      const c = lotConflicts(site.lot, lt, people);
      const n = lt.plans.filter(Boolean).length;
      console.log(`${label}：${n} 辆车，排 ${ms} 毫秒；车车重叠 ${c.carCar}、车压过斑马线上的人 ${c.carPed}（${c.samples} 个时刻）${c.pairs.join(' ')}；让行停车 ${lt.stats.waits} 次，入口晚进 ${lt.stats.entranceDelays} 辆，取货最大偏差 ${lt.stats.hardMaxDev.toFixed(1)} 秒，购物车晚到 ${lt.stats.softLate} 辆，只看前面排的 ${lt.stats.forced} 辆，没画出来的 ${lt.stats.dropped} 辆，交付时还在挪的 ${lt.stats.serveMoved} 辆`);
      // 每一辆车都画出来；没有车开过斑马线上的人；两辆车不重叠（0.5 秒一格），也没有排不开只看前面硬挤进去的车
      expect(lt.stats.dropped).toBe(0);
      expect(n).toBe(plan.stays.length);
      expect(c.carPed).toBe(0);
      expect(c.carCar).toBe(0);
      // 实在排不开、只看前面开的车：最多两辆（上面已经查过它们也没和别的车重叠）
      expect(lt.stats.forced).toBeLessThanOrEqual(2);
      // 取货的车停好的时刻：不晚过门店仿真 30 秒（等路口绿灯、前面排着车；早到就在车位里等）
      expect(lt.stats.hardMaxLate).toBeLessThanOrEqual(30);
      expect(lt.stats.hardMaxDev).toBeLessThanOrEqual(90);
      expect(lt.stats.waits).toBeGreaterThan(0);
      const pose = { x: 0, z: 0, heading: 0, speed: 0, accel: 0, rev: false, brake: false } as Parameters<typeof planPose>[2];
      let jump = { d: 0, at: '' };
      for (const p of lt.plans) {
        if (!p) continue;
        // 出场：停车线前停够让行的时间
        const holds = p.exit.filter((q) => q.kind === 'hold' && q.brake).map((q) => q.t1 - q.t0);
        if (!p.exit.length) continue;
        expect(Math.max(...holds)).toBeGreaterThanOrEqual(p.model.trailer || p.model.key === 'rv' ? 3.99 : 2.49);
        // 一路不跳：每 0.5 秒走的不超过 4 米（停车场里的车速 4.2 米 / 秒以内）
        let prev: { x: number; z: number } | undefined;
        for (let t = p.tIn; t <= p.tOut; t += 0.5) {
          if (!planPose(p, t, pose)) {
            prev = undefined;
            continue;
          }
          const d = prev ? Math.hypot(pose.x - prev.x, pose.z - prev.z) : 0;
          if (d > jump.d) jump = { d, at: `${p.i}@${t}` };
          prev = { x: pose.x, z: pose.z };
        }
      }
      expect(jump.d, jump.at).toBeLessThan(4);
      // 免下车车道：前面的车走了往前挪；交付前 25 秒到交付后 2 秒车不动
      const drive = plan.stays.map((s, i) => ({ s, p: lt.plans[i] })).filter((x) => x.s.mode === 'drive' && x.p);
      if (label === '平常') expect(drive.some((x) => (x.s.drive?.length ?? 0) > 1)).toBe(true);
      let moved = 0;
      let lateHand = 0;
      for (const { s, p } of drive) {
        const h = s.visit.handoff as number;
        if (!p) continue;
        // 交付的时候车已经停在车道里（不是还在路上）
        if (h < p.arrive) {
          lateHand++;
          continue;
        }
        planPose(p, h - 20, pose);
        const a = { x: pose.x, z: pose.z };
        planPose(p, h + 1, pose);
        if (Math.hypot(pose.x - a.x, pose.z - a.z) > 0.05) moved++;
      }
      // 交付前 20 秒到交付后 1 秒车不动
      expect(moved).toBe(0);
      expect(lateHand, '交付时还没停进车道的车').toBe(0);
      expect(lt.stats.serveMoved).toBe(0);
      // 购物的顾客下车走开的时候车已经停好（进店的时刻照门店仿真：车早到就在车里等，不晚到）
      const walkAt = new Map<number, number>();
      for (const w of people.walks) walkAt.set(w.id, Math.min(walkAt.get(w.id) ?? Infinity, w.t0));
      const shopper = (i: number) => ['shopper', 'dept'].includes(plan.stays[i]?.visit.kind ?? '');
      const early = lt.plans.filter((p, i) => p && shopper(i) && (walkAt.get(i) ?? Infinity) < p.arrive).map((p) => `${p?.i}:${plan.stays[p?.i ?? 0]?.visit.kind}`);
      expect(early, '车还没停好人就下车走了').toEqual([]);
      // 购物车：推回回收栏、走回来以后车才开走；回收员把攒满的推回店门
      for (const st of plan.stays.filter((x) => x.cart === 'corral')) {
        const id = plan.stays.indexOf(st);
        const back = people.walks.filter((w) => w.id === id).pop();
        expect(back && back.t1 <= (lt.plans[id]?.leave ?? st.leave) + 1e-6).toBe(true);
      }
      expect(people.trains.length).toBeGreaterThan(0);
    }
  });
});
