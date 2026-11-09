import { afterAll, describe, expect, it } from 'vitest';
import { footprintKm } from '../src/region/frames';
import { BOUNDS, CORES, crosses, DEFAULT_REGION, generateRegion, LOCAL, pointInPoly, polyDist, regionSpecFrom, regionSpecText, type RegionSpec } from '../src/region/regionGen';
import { FRAMES, parkKm, RAIL, RAIL_DC_INDEX, type Km } from '../src/region/region';
import { buildGraph, setRegion, shortestPath, STORE } from '../src/region/network';
import { scenarioFor, withLoad, vesselDays, flightHours, trainDays } from '../src/sim/config';
import { runChain } from '../src/sim/engine';
import { applyFacilities, defaultFacilities, randomFacilities } from '../src/facility/config';
import { setFacilities } from '../src/facility/state';
import { DOORS } from '../src/sim/board';

const SPECS: RegionSpec[] = [DEFAULT_REGION, ...Array.from({ length: 8 }, (_, i) => ({ mode: 'random' as const, seed: i + 1 })), regionSpecFrom('custom-4~sea.E~river.0~size.L~port.center~air.N~airfar.1'), regionSpecFrom('custom-9~sea.N~size.S~park.S~store.suburb')];

describe('区域生成器', () => {
  afterAll(() => setRegion(DEFAULT_REGION));

  it('默认、随机和自定义：干道只在路口相交、港口机场物流园不重叠也不出区域、门店离干道和铁路有一段距离', () => {
    for (const spec of SPECS) {
      const p = generateRegion(spec);
      const tag = regionSpecText(spec);
      const poly = (e: { a: string; b: string; via?: Km[] }) => [p.nodes[e.a] as Km, ...(e.via ?? []), p.nodes[e.b] as Km];
      const art = p.edges.filter((e) => e.cls === 'arterial' && !/^R\d/.test(e.a) && !/^R\d/.test(e.b)).map(poly);
      for (let i = 0; i < art.length; i++)
        for (let j = i + 1; j < art.length; j++) {
          const A = art[i] as Km[];
          const B = art[j] as Km[];
          let hit = false;
          for (let a = 1; a < A.length && !hit; a++) for (let b = 1; b < B.length && !hit; b++) hit = crosses(A[a - 1] as Km, A[a] as Km, B[b - 1] as Km, B[b] as Km);
          expect(hit, `${tag} 干道相交`).toBe(false);
        }
      const fps = [footprintKm(p.frames.port, LOCAL.port.rect), footprintKm(p.frames.airport, LOCAL.airport.rect), footprintKm(p.frames.park, LOCAL.park.rect)];
      for (let i = 0; i < fps.length; i++)
        for (let j = i + 1; j < fps.length; j++) for (const q of fps[i] as Km[]) expect(pointInPoly(q, fps[j] as Km[]), `${tag} 设施 ${i} 压到 ${j}`).toBe(false);
      for (const q of [...(fps[1] as Km[]), ...(fps[2] as Km[])]) expect(q.x > BOUNDS.x0 && q.x < BOUNDS.x1 && q.y > BOUNDS.y0 && q.y < BOUNDS.y1, `${tag} 设施出区域`).toBe(true);
      expect(Math.min(...art.map((l) => polyDist(p.store, l))), `${tag} 门店离干道`).toBeGreaterThan(0.9);
      expect(polyDist(p.store, p.rail), `${tag} 门店离铁路`).toBeGreaterThan(0.9);
      expect(p.ics.length, tag).toBeGreaterThanOrEqual(4);
    }
  });

  it('高速不从港口、机场、物流园的核心区里穿过（设施自己出大门的那一段除外，贴边最多 100 米）', () => {
    for (const spec of [DEFAULT_REGION, ...Array.from({ length: 30 }, (_, i) => ({ mode: 'random' as const, seed: i + 1 }))]) {
      const p = generateRegion(spec);
      const cores = [
        { id: 'PORT', poly: footprintKm(p.frames.port, CORES.port) },
        { id: 'AIR', poly: footprintKm(p.frames.airport, CORES.airport) },
        { id: 'DC', poly: footprintKm(p.frames.park, CORES.park) },
      ];
      // 点在多边形里多深（离最近的边多远，公里）
      const depth = (q: Km, poly: readonly Km[]) =>
        Math.min(
          ...poly.map((v, j) => {
            const w = poly[(j + 1) % poly.length] as Km;
            const ux = w.x - v.x;
            const uy = w.y - v.y;
            const t = Math.max(0, Math.min(1, ((q.x - v.x) * ux + (q.y - v.y) * uy) / (ux * ux + uy * uy)));
            return Math.hypot(q.x - v.x - ux * t, q.y - v.y - uy * t);
          }),
        );
      for (const e of p.edges) {
        if (e.cls !== 'highway') continue;
        const pts = [p.nodes[e.a] as Km, ...(e.via ?? []), p.nodes[e.b] as Km];
        for (let i = 1; i < pts.length; i++)
          for (let k = 0; k <= 8; k++) {
            const a = pts[i - 1] as Km;
            const b = pts[i] as Km;
            const q = { x: a.x + ((b.x - a.x) * k) / 8, y: a.y + ((b.y - a.y) * k) / 8 };
            for (const c of cores) {
              const mine = c.id === e.a || c.id === e.b;
              if (mine && c.id === 'DC') continue;
              const own = c.id === e.a ? (p.nodes[e.a] as Km) : c.id === e.b ? (p.nodes[e.b] as Km) : undefined;
              if (own && Math.hypot(q.x - own.x, q.y - own.y) < 2.2) continue;
              if (pointInPoly(q, c.poly)) expect(depth(q, c.poly), `${regionSpecText(spec)} ${e.a}-${e.b} 进了 ${c.id}`).toBeLessThan(1.0);
            }
          }
      }
    }
  });

  it('同一个规格每次一样；地址里的写法来回转不变', () => {
    expect(generateRegion({ mode: 'random', seed: 5 })).toEqual(generateRegion({ mode: 'random', seed: 5 }));
    for (const spec of SPECS) expect(regionSpecFrom(regionSpecText(spec))).toEqual(spec);
  });

  it('随机区域里所有位置都会变：海的方向、港口、机场、物流园、铁路出口、门店', () => {
    const a = generateRegion({ mode: 'random', seed: 1 });
    const b = generateRegion({ mode: 'random', seed: 2 });
    expect(a.frames.port).not.toEqual(b.frames.port);
    expect(a.frames.airport).not.toEqual(b.frames.airport);
    expect(a.frames.park).not.toEqual(b.frames.park);
    expect(a.store).not.toEqual(b.store);
    expect(a.rail[a.rail.length - 1]).not.toEqual(b.rail[b.rail.length - 1]);
  });

  it('换区域以后：铁路经过物流园货运站，道路图通到每个设施和出口，全链路照样跑得通', () => {
    const before = { ...STORE.km };
    setRegion({ mode: 'random', seed: 3 });
    expect(STORE.km).not.toEqual(before);
    const st = parkKm({ x: 10.2, y: 16.2 });
    expect(Math.hypot((RAIL[RAIL_DC_INDEX] as Km).x - st.x, (RAIL[RAIL_DC_INDEX] as Km).y - st.y)).toBeLessThan(1e-6);
    expect(FRAMES.park.rot).not.toBe(0);
    const g = buildGraph();
    for (const a of ['DC', 'PORT', 'AIR', 'NORTH', 'EAST', 'BAKERY']) expect(shortestPath(g, a, STORE.key).km, a).toBeGreaterThan(0);
    const r = runChain({ ...scenarioFor('g3', 1), days: 28, warmup: 7 });
    expect(r.store.service).toBeGreaterThan(95);
    setRegion(DEFAULT_REGION);
  });
});

describe('负荷档位', () => {
  it('平常档不改场景；高负荷放大需求、每周 3 班船和 3 列班列、每天 3 班航班，补货周期跟着缩短', () => {
    const s = scenarioFor('g3', 1);
    const n = withLoad(s, 'normal');
    expect(vesselDays(n)).toEqual([s.port.vesselDay]);
    expect(flightHours(n)).toEqual([s.air.flightHour]);
    const h = withLoad(s, 'high');
    expect(h.demand.scale).toBeCloseTo(1.8);
    expect(vesselDays(h)).toHaveLength(3);
    expect(trainDays(h)).toHaveLength(3);
    expect(flightHours(h)).toHaveLength(3);
    expect(h.dc.reviewDays.sea).toBeLessThan(s.dc.reviewDays.sea);
  });

  it('高负荷跑得通，当天的车船飞机比平常多', () => {
    const count = (lv: 'normal' | 'high') => {
      const s = withLoad(scenarioFor('g3', 1), lv);
      s.traceDay = 86;
      return runChain(s).trace?.vehicles.length ?? 0;
    };
    expect(count('high')).toBeGreaterThan(count('normal'));
  });
});

describe('设施配置', () => {
  afterAll(() => setFacilities(defaultFacilities()));

  it('默认配置不改仿真参数；收货员少了每托卸得慢，板车少了货站处理慢', () => {
    const s = scenarioFor('g3', 1);
    const d = applyFacilities(s, defaultFacilities());
    expect(d.store.unloadMinPerPallet).toBeCloseTo(s.store.unloadMinPerPallet);
    expect(d.air.handlingHours).toBeCloseTo(s.air.handlingHours);
    const f = defaultFacilities();
    f.store.staff = f.store.staff.map((r) => (r.key === 'recv' ? { ...r, crew: { early: 1, late: 1, night: 1 } } : r));
    f.airport.dollySets = 1;
    const x = applyFacilities(s, f);
    expect(x.store.unloadMinPerPallet).toBeGreaterThan(s.store.unloadMinPerPallet);
    expect(x.air.handlingHours).toBeGreaterThan(s.air.handlingHours);
  });

  it('随机生成在取值范围里、同一个编号一样（含泊位、机位、装卸线）；关掉月台门以后调度台只用开着的门', () => {
    const a = randomFacilities(7);
    expect(randomFacilities(7)).toEqual(a);
    expect(a.port.ownCranes).toBeGreaterThanOrEqual(2);
    expect(a.port.ownCranes).toBeLessThanOrEqual(5);
    expect(a.port.berths).toBeGreaterThanOrEqual(2);
    expect(a.port.berths).toBeLessThanOrEqual(4);
    expect(a.airport.stands).toBeGreaterThanOrEqual(2);
    expect(a.airport.stands).toBeLessThanOrEqual(6);
    expect(a.dc.railTracks).toBeGreaterThanOrEqual(1);
    expect(a.dc.railTracks).toBeLessThanOrEqual(4);
    const f = defaultFacilities();
    f.dc.dryDoors = 12;
    f.dc.coldDoors = 6;
    setFacilities(f);
    expect(DOORS.dry).toHaveLength(12);
    expect(DOORS.cold).toHaveLength(6);
    setFacilities(defaultFacilities());
    expect(DOORS.dry).toHaveLength(26);
  });
});

describe('比例', () => {
  it('区域 1/10、设施真实尺寸；路上车速按沙盘换算', async () => {
    const { SCALE, kmToScene, sceneToKm, roadSpeedScene, roadSpeedReal } = await import('../src/region/scale');
    const { SPEED } = await import('../web/src/three/roadnet');
    expect(SCALE.region).toBeCloseTo(0.1);
    expect(sceneToKm(kmToScene(12.3))).toBeCloseTo(12.3);
    expect(roadSpeedScene(36)).toBeCloseTo(1);
    // 高速在画面里 2.8 米 / 秒 = 真实约 100 公里 / 小时
    expect(roadSpeedReal(SPEED.highway)).toBeGreaterThan(95);
    expect(roadSpeedReal(SPEED.highway)).toBeLessThan(110);
  });
});
