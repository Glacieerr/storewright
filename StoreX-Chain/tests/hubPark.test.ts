import { beforeAll, describe, expect, it } from 'vitest';
import { planPark, RAIL_YARD, type ParkPlan } from '../src/hub/park';
import { HUB_SLOTS } from '../src/hub/types';
import { setRegion } from '../src/region/network';
import { buildBoard } from '../src/sim/board';
import { LOADS, scenarioFor, withLoad, type LoadLevel } from '../src/sim/config';
import { runChain } from '../src/sim/engine';
import { allocationHour, emptyDay } from '../src/sim/plan';
import { TRACE_DAY } from '../src/analysis/studies';

/** 物流园的计划：按仿真的一天（默认区域，第 1 组）排，和网页里调度台、三维用的输入一样 */
function plan(level: LoadLevel, seed = 1): ParkPlan {
  const s = withLoad(scenarioFor('g3', seed), level);
  s.traceDay = TRACE_DAY;
  const tr = runChain(s).trace;
  if (!tr) throw new Error('没有轨迹');
  const board = buildBoard(tr.ops, emptyDay(), { allocation: allocationHour(s), crossDock: s.dc.crossDock });
  const byV = new Map(board.ops.filter((o) => o.vehicle >= 0).map((o) => [o.vehicle, o]));
  const place = (d?: string) => (d ? (d.startsWith('C') ? `DCC#${Number(d.slice(1)) - 1}` : `DC#${Number(d.slice(1)) - 1}`) : undefined);
  return planPark({
    vehicles: tr.vehicles,
    doorOf: (vid, key) => (key === 'DC' ? place(byV.get(vid)?.door) : undefined),
    bookings: board.doors.flatMap((d) => d.bookings.map((b) => ({ door: b.door, t0: b.t0, t1: b.t1, mode: b.mode }))),
    palletsOf: (vid) => byV.get(vid)?.pallets,
    seed,
    traffic: LOADS[level].traffic,
    tracks: 2,
  });
}

describe('物流园的仓储和场地计划', () => {
  let normal: ParkPlan;
  let extreme: ParkPlan;
  beforeAll(() => {
    setRegion({ mode: 'default', seed: 1 });
    normal = plan('normal');
    extreme = plan('extreme');
  }, 120000);

  it('同一个门不会同时有两辆车（含倒车、拉出）', () => {
    for (const p of [normal, extreme]) {
      const by = new Map<string, { t0: number; t1: number }[]>();
      for (const u of p.doorUse) by.set(u.door, [...(by.get(u.door) ?? []), u]);
      for (const list of by.values()) {
        list.sort((a, b) => a.t0 - b.t0);
        for (let i = 1; i < list.length; i++) expect((list[i] as { t0: number }).t0).toBeGreaterThanOrEqual((list[i - 1] as { t1: number }).t1 - 1);
      }
    }
  });

  it('本店的仿真车按仿真的时刻：到了才登记，靠台在登记以后，拉出就是仿真离开的时刻', () => {
    for (const p of [normal, extreme]) {
      expect(p.sims.length).toBeGreaterThan(0);
      for (const s of p.sims) {
        expect(s.checkIn[0]).toBeCloseTo(s.arrive, 6);
        expect(s.dockAt[1]).toBeCloseTo(s.leave, 6);
        if (!s.drop) expect(s.dockAt[0]).toBeGreaterThanOrEqual(s.checkIn[1] - 1e-6);
        if (s.hold) {
          expect(s.hold.t0).toBeGreaterThanOrEqual(s.checkIn[1]);
          expect(s.hold.t1).toBeLessThanOrEqual(s.dockAt[0]);
        }
      }
    }
  });

  it('甩挂区、待命停车场：同一个车位不会同时停两辆，总数不超过车位数', () => {
    for (const p of [normal, extreme]) {
      const by = new Map<string, { t0: number; t1: number }[]>();
      for (const t of p.trailers) by.set(t.stall, [...(by.get(t.stall) ?? []), t]);
      for (const list of by.values()) {
        list.sort((a, b) => a.t0 - b.t0);
        for (let i = 1; i < list.length; i++) expect((list[i] as { t0: number }).t0).toBeGreaterThanOrEqual((list[i - 1] as { t1: number }).t1 - 1);
      }
      const drop = p.hub.occupancy.drop as Float32Array;
      const hold = p.hub.occupancy.hold as Float32Array;
      for (let k = 0; k < HUB_SLOTS; k++) {
        expect(drop[k]).toBeLessThanOrEqual(p.layout.drop.stalls.length + 1e-6);
        expect(hold[k]).toBeLessThanOrEqual(p.layout.hold.stalls.length + 1e-6);
      }
      const holdLegs = p.actors.flatMap((a) => a.legs.filter((l) => l.kind === 'hold' && l.stall).map((l) => ({ stall: l.stall as string, t0: l.t0, t1: l.t1 })));
      const hs = new Map<string, { t0: number; t1: number }[]>();
      for (const h of holdLegs) hs.set(h.stall, [...(hs.get(h.stall) ?? []), h]);
      for (const list of hs.values()) {
        list.sort((a, b) => a.t0 - b.t0);
        for (let i = 1; i < list.length; i++) expect((list[i] as { t0: number }).t0).toBeGreaterThanOrEqual((list[i - 1] as { t1: number }).t1 - 1);
      }
    }
  });

  it('箱不多不少：每个箱落地一次，被提走的有龙门吊装箱，拆完的空箱放回箱位，本店的箱进配送中心收货门', () => {
    for (const p of [normal, extreme]) {
      const ids = p.boxes.map((b) => b.id);
      expect(new Set(ids).size).toBe(ids.length);
      const outs = [...p.transfers.W, ...p.transfers.E].filter((x) => x.dir === 'out');
      const ins = [...p.transfers.W, ...p.transfers.E].filter((x) => x.dir === 'in');
      const picked = p.boxes.filter((b) => b.pickAt !== undefined);
      expect(outs.length).toBe(picked.length);
      expect(ins.length).toBe(p.boxes.filter((b) => b.emptyAt !== undefined).length);
      for (const b of picked) {
        expect(b.pickAt as number).toBeGreaterThan(b.landAt);
        expect(outs.filter((x) => x.box === b.id)).toHaveLength(1);
      }
      for (const b of p.boxes.filter((x) => x.own)) {
        expect(b.dest).toBe('dc');
        if (b.devan) expect(p.layout.doors.find((d) => d.id === b.door)?.receiving).toBe(true);
      }
      // 今天卸下来的箱都是仿真里的班列带来的（港口班列都是本店的，洲际班列 12 箱）
      for (const b of p.boxes.filter((x) => !x.background)) expect(b.train).toBeDefined();
      // 箱位：同一个位置同一时间只有一个箱
      for (const s of ['W', 'E'] as const) {
        const occ = p.boxes.filter((b) => b.section === s).flatMap((b) => [{ k: `${b.slot.u}:${b.slot.v}:${b.slot.tier}`, t0: b.landAt, t1: b.pickAt ?? Infinity }, ...(b.emptySlot ? [{ k: `${b.emptySlot.u}:${b.emptySlot.v}:${b.emptySlot.tier}`, t0: b.emptyAt as number, t1: Infinity }] : [])]);
        const by = new Map<string, { t0: number; t1: number }[]>();
        for (const o of occ) by.set(o.k, [...(by.get(o.k) ?? []), o]);
        for (const list of by.values()) {
          list.sort((a, b) => a.t0 - b.t0);
          for (let i = 1; i < list.length; i++) expect((list[i] as { t0: number }).t0).toBeGreaterThanOrEqual((list[i - 1] as { t1: number }).t1 - 1);
        }
        for (const o of occ) expect(Number(o.k.split(':')[2])).toBeLessThan(RAIL_YARD.tiers);
      }
    }
  });

  it('龙门吊一次只做一件事，列车作业时不做集卡道的活', () => {
    for (const p of [normal, extreme])
      for (const s of ['W', 'E'] as const) {
        const list = [...p.transfers[s]].sort((a, b) => a.t0 - b.t0);
        for (let i = 1; i < list.length; i++) expect((list[i] as { t0: number }).t0).toBeGreaterThanOrEqual((list[i - 1] as { t1: number }).t1 - 1e-6);
      }
  });

  it('场内的车不会瞬移：每一段接着上一段的时刻和位置', () => {
    for (const p of [normal, extreme])
      for (const a of p.actors) {
        expect(a.legs.length).toBeGreaterThan(0);
        for (let i = 1; i < a.legs.length; i++) {
          const x = a.legs[i - 1] as (typeof a.legs)[number];
          const y = a.legs[i] as (typeof a.legs)[number];
          expect(Math.abs(y.t0 - x.t1)).toBeLessThan(1);
          expect(y.t1).toBeGreaterThanOrEqual(y.t0);
          const pe = x.path?.[x.path.length - 1];
          const ps = y.path?.[0];
          if (pe && ps) expect(Math.hypot(pe.x - ps.x, pe.z - ps.z)).toBeLessThan(1);
        }
      }
  });

  it('转运仓暂存道上的托盘守恒，值班助手的一天齐全', () => {
    for (const p of [normal, extreme]) {
      expect(p.hub.key).toBe('park');
      for (let k = 0; k < HUB_SLOTS; k++) expect(p.staging[k]).toBeGreaterThanOrEqual(0);
      for (const z of p.hub.zones) expect((p.hub.occupancy[z.key] as Float32Array).length).toBe(HUB_SLOTS);
      for (const k of p.hub.kpi) expect(Number.isFinite(k.value)).toBe(true);
      expect(p.hub.notes.length).toBeGreaterThan(1);
      expect(p.hub.flows.some((f) => f.own && f.unit === '箱')).toBe(true);
    }
    // 负荷高了，场里更忙
    expect(extreme.actors.length).toBeGreaterThan(normal.actors.length);
  });

  it('同样的输入每次一样', () => {
    const again = plan('normal');
    const sig = (p: ParkPlan) => JSON.stringify({ a: p.actors.map((x) => [x.id, x.legs.length, Math.round(x.legs[x.legs.length - 1]?.t1 ?? 0)]), d: p.doorUse.map((u) => [u.door, Math.round(u.t0)]), k: p.hub.kpi.map((k) => k.value.toFixed(3)) });
    expect(sig(again)).toBe(sig(normal));
  }, 60000);
  it('场内车（短驳车、场内牵引车）闲着的时候回待命停车场的车位，不停在路上、门前', () => {
    for (const p of [normal, extreme]) {
      const H = p.layout.hold;
      const inHold = (q: { x: number; z: number }) => q.x > H.x0 - 3 && q.x < H.x1 + 3 && q.z > H.z0 - 3 && q.z < H.z1 + 3;
      const idle = p.actors.filter((a) => a.kind === 'shunter' || a.kind === 'shuttle').flatMap((a) => a.legs.filter((l) => l.kind === 'park' && !l.door && !l.stall && !l.lane && l.t1 - l.t0 > 900 && l.t0 > 0 && l.t1 < 86400));
      const onRoad = idle.filter((l) => !inHold(l.path?.[0] ?? { x: 0, z: 0 }));
      expect(idle.length).toBeGreaterThan(0);
      expect(onRoad.length / idle.length).toBeLessThan(0.2);
    }
  });
  it('出门登记亭同一条车道上一次只有一辆车（登记的时段不重叠）', () => {
    for (const p of [normal, extreme]) {
      const outs = p.actors.flatMap((a) => a.legs.filter((l) => l.kind === 'kiosk' && /出门/.test(l.note ?? '')).map((l) => ({ k: /2 号/.test(l.note ?? '') ? 1 : 0, t0: l.t0, t1: l.t1 })));
      for (const a of outs) for (const b of outs) if (a !== b && a.k === b.k) expect(a.t1 <= b.t0 || b.t1 <= a.t0).toBe(true);
    }
  });
});
