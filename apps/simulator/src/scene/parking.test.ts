import { describe, expect, it } from 'vitest';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { buildGeometry } from './layout';
import { OVERFLOW_RESERVE, PathChain, SPOT_D, SPOT_W, TimedPath, type PathState } from './lot';
import { generateSite } from './site';
import { backInPaths, bayCovers, facingSpot, forwardExitPath, longBays, longPaths, LONG_MERGE, LONG_SPOTS, pullThroughPath, TowRig } from './parking';
import { generateStays } from './shoppers';

const geo = buildGeometry(new StoreModel(createTemplate('medium')));
const f0 = geo.floors[0] as (typeof geo.floors)[number];
const lot = geo.lot;
const site = generateSite({ lot, store: { minX: f0.minX, maxX: f0.maxX, minZ: f0.minZ, maxZ: f0.maxZ }, settings: { style: 'suburban', seed: 1, traffic: 1 } });
const st: PathState = { x: 0, z: 0, heading: 0 };
const ang = (a: number, b: number) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

describe('停车方式（决策记录 0018）', () => {
  it('长车位：最远一排两端各一个，连续的车位、中间没有购物车回收栏；车辆停在车位前沿、平行于车道', () => {
    const bays = longBays(lot);
    expect(bays).toHaveLength(2);
    const rows = lot.aisles.length - 1;
    for (const b of bays) {
      expect(b.spots.length).toBe(Math.max(...Object.values(LONG_SPOTS)));
      const spots = b.spots.map((i) => lot.spots[i] as (typeof lot.spots)[number]);
      for (const s of spots) {
        expect(s.aisle).toBe(rows);
        expect(s.heading).toBe(0);
      }
      for (let k = 1; k < spots.length; k++) expect(Math.abs(Math.abs((spots[k] as (typeof spots)[number]).x - (spots[k - 1] as (typeof spots)[number]).x) - SPOT_W)).toBeLessThan(0.05);
      for (const c of lot.corrals) expect(Math.abs(c.x - (b.xTail + b.xHead) / 2) > Math.abs(b.xHead - b.xTail) / 2).toBe(true);
      // 停放中线在车位前沿一侧，车身（半宽 1.3 米）不越出车位
      const z0 = (spots[0] as (typeof spots)[number]).z - SPOT_D / 2;
      expect(b.parkZ - 1.3).toBeGreaterThanOrEqual(z0 - 0.01);
      expect(b.parkZ + 1.3).toBeLessThanOrEqual(z0 + SPOT_D);
      expect(bayCovers(b, 'rv')).toHaveLength(LONG_SPOTS.rv);
    }
    expect(bays.map((b) => b.dir).sort()).toEqual([-1, 1]);
  });

  it('房车与带拖车的车：驶入终点就是停放位置，驶离从停放位置出发、回到主路，路边停下让行；拖车停好时与车辆摆正', () => {
    for (const b of longBays(lot)) {
      for (const [front, hitch, axle, kind] of [
        [5.6, 0, 0, 'rv'],
        [2.94, 3.2, 6.45, 'camper'],
        [2.94, 3.2, 3.0, 'utility'],
      ] as const) {
        const need = LONG_SPOTS[kind];
        const p = longPaths(lot, site.road, b, front, need, b.dir > 0, b.dir < 0, LONG_MERGE[kind]);
        p.entry.at(p.entry.duration, st);
        expect(Math.hypot(st.x - p.parked.x, st.z - p.parked.z)).toBeLessThan(0.05);
        expect(Math.abs(ang(st.heading, p.parked.heading))).toBeLessThan(0.05);
        // 车头离车位端头 0.8 米
        expect(Math.abs(p.parked.x + b.dir * front - (b.xHead - b.dir * 0.8))).toBeLessThan(0.05);
        p.exit.at(0, st);
        expect(Math.hypot(st.x - p.parked.x, st.z - p.parked.z)).toBeLessThan(0.05);
        p.exit.at(p.exit.duration, st);
        expect(st.z).toBeLessThan(lot.edgeZ);
        // 驶出停车场前有一段停车让行（车速为 0 持续几秒）
        let still = 0;
        for (let t = 0; t <= p.exit.duration; t += 0.25) {
          p.exit.at(t, st);
          if ((st.speed ?? 0) < 0.01 && st.z < lot.edgeZ - 1 && st.z > lot.edgeZ - 4) still += 0.25;
        }
        expect(still).toBeGreaterThanOrEqual(2);
        // 车身（半宽 1.25 米）进入车位范围（超过车位前沿 0.25 米，停着的车车尾离前沿约 0.3 米）时，已经在长车位的 x 范围内
        const zFront = b.aisleZ + 3.5;
        // 这辆车占用的车位范围（含车尾后面并进来用的一个）
        const xs = [b.xHead - b.dir * need * SPOT_W, b.xHead].sort((u, v) => u - v) as [number, number];
        // 这一排车位的 x 范围（环形车道和端头绿化岛上不算）
        const row = lot.spots.filter((q) => q.kind === 'general' && q.aisle === lot.aisles.length - 1 && q.heading === 0).map((q) => q.x);
        const rowX = [Math.min(...row) - SPOT_W / 2, Math.max(...row) + SPOT_W / 2] as const;
        const rig = hitch > 0 ? new TowRig(p.entry, hitch, axle) : undefined;
        for (let t = 0; t <= p.entry.duration; t += 0.2) {
          p.entry.at(t, st);
          const ends = [{ x: st.x + Math.sin(st.heading) * front, z: st.z + Math.cos(st.heading) * front }];
          if (rig) {
            const th = rig.trailerAt(t);
            const hx = st.x - hitch * Math.sin(st.heading);
            const hz = st.z - hitch * Math.cos(st.heading);
            ends.push({ x: hx - Math.sin(th) * (axle + 3), z: hz - Math.cos(th) * (axle + 3) });
          } else ends.push({ x: st.x - Math.sin(st.heading) * front, z: st.z - Math.cos(st.heading) * front });
          for (const e of ends) if (e.z + 1.25 > zFront + 0.25 && e.x > rowX[0] && e.x < rowX[1]) expect(e.x > xs[0] - 0.3 && e.x < xs[1] + 0.3).toBe(true);
        }
        // 拖车停好时与车辆基本摆正（受长车位长度所限，最多偏 6°）
        if (rig) expect(Math.abs(ang(rig.end(), p.parked.heading))).toBeLessThan(0.105);
      }
    }
  });

  it('倒车入位与穿过对面空车位：最后停在车位中心、车头朝外；离开时直接向前开出', () => {
    const idx = lot.spots.findIndex((s) => s.kind === 'general' && facingSpot(lot, lot.spots.indexOf(s)) >= 0);
    const spot = lot.spots[idx] as (typeof lot.spots)[number];
    const [ap, bk] = backInPaths(lot, site.road, spot, true);
    ap.at(ap.duration, st);
    const end = { ...st };
    bk.at(0, st);
    expect(Math.hypot(st.x - end.x, st.z - end.z)).toBeLessThan(0.05);
    bk.at(bk.duration, st);
    expect(Math.hypot(st.x - spot.x, st.z - spot.z)).toBeLessThan(0.05);
    expect(Math.abs(ang(st.heading, spot.heading + Math.PI))).toBeLessThan(0.05);
    const th = pullThroughPath(lot, site.road, spot, false);
    th.at(th.duration, st);
    expect(Math.hypot(st.x - spot.x, st.z - spot.z)).toBeLessThan(0.05);
    expect(Math.abs(ang(st.heading, spot.heading + Math.PI))).toBeLessThan(0.05);
    const fw = forwardExitPath(lot, site.road, spot, true);
    fw.at(0, st);
    expect(Math.hypot(st.x - spot.x, st.z - spot.z)).toBeLessThan(0.05);
    fw.at(fw.duration, st);
    expect(st.z).toBeLessThan(lot.edgeZ);
    // 对面车位是同一列、背靠背的那个
    const face = lot.spots[facingSpot(lot, idx)] as (typeof lot.spots)[number];
    expect(Math.abs(face.x - spot.x)).toBeLessThan(0.05);
    expect(Math.abs(Math.abs(face.z - spot.z) - SPOT_D)).toBeLessThan(0.05);
  });

  it('停留安排：长车占用的车位那段时间不停别的车；每个车位的停留按时间排列、互不重叠；有倒车入位和穿过停，越靠门口停得越满', () => {
    const stays = generateStays({ lot, seed: 3, reserve: OVERFLOW_RESERVE, busyness: 1 });
    const bays = longBays(lot);
    const longs = stays.flat().filter((s) => s.long);
    expect(longs.length).toBeGreaterThanOrEqual(4);
    expect(longs.some((s) => s.long?.kind === 'rv')).toBe(true);
    expect(longs.some((s) => s.long && s.long.kind !== 'rv' && (s.type === 'pickup' || s.type === 'suv'))).toBe(true);
    for (const s of longs) {
      const covers = bayCovers(bays[s.long?.bay ?? 0] as (typeof bays)[number], s.long?.kind ?? 'rv');
      for (const i of covers) {
        for (const o of stays[i] ?? []) if (o !== s) expect(o.leave < s.arrive - 60 || o.arrive > s.leave + 60).toBe(true);
      }
    }
    for (const list of stays) for (let k = 1; k < list.length; k++) expect((list[k] as (typeof list)[number]).arrive).toBeGreaterThanOrEqual((list[k - 1] as (typeof list)[number]).leave);
    const all = stays.flat().filter((s) => !s.long);
    const back = all.filter((s) => s.mode === 'back').length / all.length;
    const through = all.filter((s) => s.mode === 'through').length / all.length;
    expect(back).toBeGreaterThan(0.05);
    expect(back).toBeLessThan(0.2);
    expect(through).toBeGreaterThan(0.01);
    expect(through).toBeLessThan(0.1);
    // 穿过停：到达时对面的车位空着
    for (const [i, list] of stays.entries()) {
      for (const s of list) {
        if (s.mode !== 'through') continue;
        const face = facingSpot(lot, i);
        expect(face).toBeGreaterThanOrEqual(0);
        for (const o of stays[face] ?? []) expect(o.arrive - 150 >= s.arrive + 30 || o.leave + 150 <= s.arrive - 90).toBe(true);
      }
    }
    // 中午前后：门口附近一半车位的平均占用比远处一半高
    const first = lot.pickupCount + OVERFLOW_RESERVE;
    const occ = (i: number) => (stays[i] ?? []).reduce((n, s) => n + Math.max(0, Math.min(s.leave, 14 * 3600) - Math.max(s.arrive, 11 * 3600)), 0);
    const gen = lot.spots.map((_, i) => i).filter((i) => i >= first && !(stays[i] ?? []).some((s) => s.staff));
    const half = Math.floor(gen.length / 2);
    const mean = (ids: number[]) => ids.reduce((n, i) => n + occ(i), 0) / Math.max(1, ids.length);
    expect(mean(gen.slice(0, half))).toBeGreaterThan(mean(gen.slice(half)));
  });

  it('停车等待：几段路径首尾相接，中间停住的那几秒车速为 0', () => {
    const a = new TimedPath(
      [
        { x: 0, z: 0 },
        { x: 0, z: 20 },
      ],
      () => 5,
      false,
      { v1: 0 },
    );
    const b = new TimedPath(
      [
        { x: 0, z: 20 },
        { x: 20, z: 20 },
      ],
      () => 5,
      false,
      { v0: 0 },
    );
    const c = new PathChain([a, 3, b]);
    expect(c.duration).toBeCloseTo(a.duration + 3 + b.duration, 6);
    c.at(a.duration + 1.5, st);
    expect(st.speed).toBe(0);
    expect(st.z).toBeCloseTo(20, 6);
    c.at(c.duration, st);
    expect(st.x).toBeCloseTo(20, 6);
  });
});
