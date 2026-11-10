import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { footprintKm } from '../src/region/frames';
import { L, LAND, landAt, planLandUse, seaTester } from '../src/region/landuse';
import { setRegion } from '../src/region/network';
import { crosses, DEFAULT_REGION, generateRegion, LOCAL, pointInPoly, randomOptions, regionSpecFrom, storeSitePoly, type RegionPlan, type RegionSpec } from '../src/region/regionGen';
import { layoutCity } from '../web/src/three/cityplan';
import { RoadNet } from '../web/src/three/roadnet';

/**
 * 城市总体规划（用地布局）和随机区域的检查：默认区域的仿真规划不变；同一个区域每次一样；噪声区里没有居住、学校和医院；
 * 居住和重工业、物流之间隔着绿带；用地结构在常见的范围里；生活圈盖住居住用地；设施的占地里不划别的用地；
 * 货运通道、门店的配送通道；随机区域的城市形态、海岸、支流、岛都出现，生成的区域都合理；小街铺得满。
 */
const RANDOM = Array.from({ length: 40 }, (_, i): RegionSpec => ({ mode: 'random', seed: i + 1 }));
const hashGrid = (p: RegionPlan) => createHash('md5').update(planLandUse(p).grid.code).digest('hex');

describe('用地规划', () => {
  afterAll(() => setRegion(DEFAULT_REGION));

  // 取指纹以前把数字取整到 1e-9 公里（1 微米）：JavaScript 引擎 V8 的 sin、cos、atan2、exp 和一般的乘方，在 Apple 芯片（arm64）和 Intel / AMD（x64）上
  // 最后一位会不一样。2026-11-09 实测默认区域：2,161 个数里有 4 个差 1e-15 公里左右，结构完全一样，报告里的数字两边也完全一样；
  // 不取整的指纹在 arm64 上是 312690be…、在 x64 上是 80f875df…（GitHub 的测试机是 x64）。
  it('默认区域的仿真规划没有变（报告里的数字按它算）', () => {
    const json = JSON.stringify(generateRegion(DEFAULT_REGION), (_k, v: unknown) => (typeof v === 'number' ? Math.round(v * 1e9) : v));
    expect(createHash('md5').update(json).digest('hex')).toBe('be386fba951f7d5cd8d0f31390459e28');
  });

  it('同一个区域每次一样（换一个区域对象重算，栅格一模一样）', () => {
    for (const spec of [DEFAULT_REGION, { mode: 'random' as const, seed: 7 }, { mode: 'random' as const, seed: 27 }]) {
      expect(hashGrid(generateRegion(spec))).toBe(hashGrid(generateRegion(spec)));
    }
  });

  it('噪声区里没有居住、学校、医院；居住和重工业、二类物流、环境设施、港口之间隔着绿带', () => {
    for (const spec of [DEFAULT_REGION, ...RANDOM.slice(0, 20)]) {
      const p = generateRegion(spec);
      const lu = planLandUse(p);
      const g = lu.grid;
      const nz = lu.noise;
      const len = Math.hypot(nz.b.x - nz.a.x, nz.b.y - nz.a.y);
      const u = { x: (nz.b.x - nz.a.x) / len, y: (nz.b.y - nz.a.y) / len };
      const sensitive = new Set<number>([L.R1, L.R2, L.A33, L.A5, L.A31]);
      const heavy = new Set<number>([L.M2, L.W2, L.U2, L.PORT]);
      let inNoise = 0;
      let touching = 0;
      for (let i = 0; i < g.code.length; i++) {
        const c = g.code[i] as number;
        if (!sensitive.has(c)) continue;
        const x = g.x0 + ((i % g.w) + 0.5) * g.cell;
        const y = g.y0 + (Math.floor(i / g.w) + 0.5) * g.cell;
        const t = (x - nz.a.x) * u.x + (y - nz.a.y) * u.y;
        const lat = Math.abs(-(x - nz.a.x) * u.y + (y - nz.a.y) * u.x);
        const beyond = t < 0 ? -t : t > len ? t - len : 0;
        if (beyond <= nz.ext70 && lat <= nz.half70 * (1 - (0.55 * beyond) / nz.ext70) - g.cell) inNoise++;
        // 紧挨着（相邻格子）就是重工业、二类物流、环境设施、港口
        const cx = i % g.w;
        const cy = Math.floor(i / g.w);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const n = (cy + dy) * g.w + cx + dx;
          if (heavy.has(g.code[n] as number)) touching++;
        }
      }
      expect(inNoise, `${spec.mode}-${spec.seed} 噪声区里的居住`).toBe(0);
      expect(touching, `${spec.mode}-${spec.seed} 居住挨着重工业`).toBe(0);
    }
  });

  it('用地结构在常见的范围里（居住二到五成、公共服务和绿地有一定比例、道路一成以上）', () => {
    for (const spec of [DEFAULT_REGION, ...RANDOM.slice(0, 12)]) {
      const lu = planLandUse(generateRegion(spec));
      const share = Object.fromEntries(lu.stats.map((s) => [s.group, s.share]));
      const tag = `${spec.mode}-${spec.seed}`;
      expect(share.R, tag).toBeGreaterThan(0.2);
      expect(share.R, tag).toBeLessThan(0.5);
      expect(share.A, tag).toBeGreaterThan(0.03);
      expect(share.G, tag).toBeGreaterThan(0.07);
      expect(share.S, tag).toBeGreaterThan(0.08);
      expect((share.M ?? 0) + (share.W ?? 0), tag).toBeGreaterThan(0.1);
    }
  });

  it('生活圈盖住居住用地；设施的占地里不划别的用地；货运通道和门店的配送通道', () => {
    for (const spec of [DEFAULT_REGION, ...RANDOM.slice(0, 8)]) {
      const p = generateRegion(spec);
      const lu = planLandUse(p);
      const g = lu.grid;
      const tag = `${spec.mode}-${spec.seed}`;
      const spacing = Math.max(1.6, p.city.radius * 0.19);
      let resi = 0;
      let covered = 0;
      for (let i = 0; i < g.code.length; i++) {
        const c = g.code[i] as number;
        if (c !== L.R1 && c !== L.R2) continue;
        const x = g.x0 + ((i % g.w) + 0.5) * g.cell;
        const y = g.y0 + (Math.floor(i / g.w) + 0.5) * g.cell;
        resi++;
        if (lu.lifeCircles.some((lc) => Math.hypot(lc.c.x - x, lc.c.y - y) <= spacing + 0.3)) covered++;
      }
      expect(covered / Math.max(1, resi), `${tag} 生活圈`).toBeGreaterThan(0.9);
      // 设施占地的中间那一块：港口是港口用地、机场是机场用地、物流园是物流仓储
      for (const [f, rect, want] of [
        [p.frames.port, LOCAL.port.rect, [L.PORT, L.WATER]],
        [p.frames.airport, LOCAL.airport.rect, [L.AIRPORT, L.WATER]],
        [p.frames.park, LOCAL.park.rect, [L.W2]],
      ] as const) {
        const poly = footprintKm(f, rect);
        const c = { x: poly.reduce((a, q) => a + q.x, 0) / 4, y: poly.reduce((a, q) => a + q.y, 0) / 4 };
        expect((want as readonly number[]).includes(landAt(lu, c)), `${tag} 设施中间`).toBe(true);
      }
      const kinds = new Set(lu.corridors.map((c) => c.kind));
      expect(kinds.has('freight'), tag).toBe(true);
      expect(kinds.has('delivery'), `${tag} 门店配送通道`).toBe(true);
      for (const e of p.edges) if (e.cls === 'highway' || e.cls === 'ring') expect(lu.corridors.find((c) => c.a === e.a && c.b === e.b)?.kind, tag).toBe('freight');
      expect(lu.centers[0]?.main, tag).toBe(true);
      expect(lu.rules.length, tag).toBeGreaterThan(5);
      for (const k of lu.stats) expect(LAND.some((c) => c.group === k.group), tag).toBe(true);
    }
  });
});

describe('随机区域', () => {
  afterAll(() => setRegion(DEFAULT_REGION));

  it('城市形态、海岸、支流都出现；河口那种海岸有岛；多组团有副中心', () => {
    const forms = new Set<string>();
    const coasts = new Set<string>();
    let branches = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const o = randomOptions(seed);
      forms.add(o.form as string);
      coasts.add(o.coast as string);
    }
    expect([...forms].sort()).toEqual(['cluster', 'grid', 'linear', 'organic', 'radial']);
    expect([...coasts].sort()).toEqual(['bay', 'estuary', 'peninsula', 'straight', 'wavy']);
    let estuaries = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const o = randomOptions(seed);
      if (o.coast !== 'estuary' && o.form !== 'cluster' && o.riverForm !== 'branching') continue;
      const p = generateRegion({ mode: 'random', seed });
      if (p.options.coast === 'estuary') {
        estuaries++;
        expect(p.islands?.length ?? 0, `random-${seed} 河口的岛`).toBeGreaterThan(0);
      }
      if (p.options.form === 'cluster') expect(p.city.centers.length, `random-${seed} 组团`).toBeGreaterThanOrEqual(3);
      if (p.river?.branches?.length) branches++;
    }
    expect(estuaries).toBeGreaterThan(0);
    expect(branches).toBeGreaterThan(5);
  });

  it('生成的区域都合理：干道只在路口相交、设施不重叠、岛在海里不压设施、默认区域没有新加的项', () => {
    for (const spec of RANDOM) {
      const p = generateRegion(spec);
      const tag = `random-${spec.seed}`;
      const poly = (e: { a: string; b: string; via?: { x: number; y: number }[] }) => [p.nodes[e.a] as { x: number; y: number }, ...(e.via ?? []), p.nodes[e.b] as { x: number; y: number }];
      const art = p.edges.filter((e) => e.cls === 'arterial' && !/^R\d/.test(e.a) && !/^R\d/.test(e.b)).map(poly);
      for (let i = 0; i < art.length; i++)
        for (let j = i + 1; j < art.length; j++) {
          const A = art[i] as { x: number; y: number }[];
          const B = art[j] as { x: number; y: number }[];
          let hit = false;
          for (let a = 1; a < A.length && !hit; a++) for (let b = 1; b < B.length && !hit; b++) hit = crosses(A[a - 1] as { x: number; y: number }, A[a] as { x: number; y: number }, B[b - 1] as { x: number; y: number }, B[b] as { x: number; y: number });
          expect(hit, `${tag} 干道相交`).toBe(false);
        }
      const foots = [footprintKm(p.frames.port, LOCAL.port.rect), footprintKm(p.frames.airport, LOCAL.airport.rect), footprintKm(p.frames.park, LOCAL.park.rect)];
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) for (const q of foots[i] as { x: number; y: number }[]) expect(pointInPoly(q, foots[j] as { x: number; y: number }[]), `${tag} 设施重叠`).toBe(false);
      // 岛：顶点在海里（不算岛自己）、不压设施
      const bare = seaTester({ ...p, islands: undefined } as RegionPlan);
      for (const isl of p.islands ?? []) {
        for (const q of isl) expect(bare(q), `${tag} 岛在陆地上`).toBe(true);
        for (const f of foots) for (const q of isl) expect(pointInPoly(q, f), `${tag} 岛压设施`).toBe(false);
      }
      // 支流的最后一点在干流上
      for (const b of p.river?.branches ?? []) {
        const end = b[b.length - 1] as { x: number; y: number };
        expect(Math.min(...(p.river?.pts ?? []).map((q) => Math.hypot(q.x - end.x, q.y - end.y))), `${tag} 支流汇进干流`).toBeLessThan(0.05);
      }
    }
    const d = generateRegion(DEFAULT_REGION);
    expect(d.options.form).toBeUndefined();
    expect(d.islands).toBeUndefined();
    expect(d.river?.branches).toBeUndefined();
  });

  it('小街铺得满：小街总长至少是干道的三成（默认和几个随机区域，包括小城市）', () => {
    for (const spec of [DEFAULT_REGION, { mode: 'random' as const, seed: 1 }, { mode: 'random' as const, seed: 3 }, { mode: 'random' as const, seed: 11 }, { mode: 'random' as const, seed: 27 }]) {
      setRegion(spec);
      const net = new RoadNet();
      const plan = layoutCity(net);
      const streets = plan.streets.lines.reduce((a, l) => a + l.len, 0);
      const art = net.lines.filter((l) => l.cls === 'arterial').reduce((a, l) => a + l.len, 0);
      expect(streets / art, `${spec.mode}-${spec.seed ?? ''} 小街 ${Math.round(streets)} / 干道 ${Math.round(art)}`).toBeGreaterThan(0.3);
      // 每条小街两头都是路口（T 形、十字或带回车场的尽头路），不出城区
      for (const l of plan.streets.lines) {
        expect(net.junctions.has(l.ja) && net.junctions.has(l.jb)).toBe(true);
      }
    }
  });

  it('门店站点（店前停车场、店房、百货馆、收货场、两侧通道）整块不压路、铁路、河和海，进店路的路口在正前方', () => {
    type P = { x: number; y: number };
    const specs: RegionSpec[] = [...RANDOM, regionSpecFrom('custom-5~store.center~form.grid'), regionSpecFrom('custom-12~store.suburb~coast.bay'), regionSpecFrom('custom-21~store.urban~form.linear')];
    for (const spec of specs) {
      const p = generateRegion(spec);
      const tag = `${spec.mode}-${spec.seed}`;
      // 进店路接在离门店最近的干道路口（和 network.ts 选法一样），门店正面朝它
      const art = p.edges.filter((e) => e.cls === 'arterial');
      const ids = [...new Set(art.flatMap((e) => [e.a, e.b]))].filter((id) => !/^(R\d+|BE\d)$/.test(id));
      const node = ids.reduce((b, id) => (Math.hypot((p.nodes[id] as P).x - p.store.x, (p.nodes[id] as P).y - p.store.y) < Math.hypot((p.nodes[b] as P).x - p.store.x, (p.nodes[b] as P).y - p.store.y) ? id : b), ids[0] as string);
      const n = p.nodes[node] as P;
      const l = Math.hypot(n.x - p.store.x, n.y - p.store.y);
      const poly = storeSitePoly(p.store, { x: (n.x - p.store.x) / l, y: (n.y - p.store.y) / l });
      const hits = (pts: readonly P[]) => {
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1] as P;
          const b = pts[i] as P;
          const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.05));
          for (let j = 0; j <= k; j++) if (pointInPoly({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k }, poly)) return true;
        }
        return false;
      };
      for (const e of p.edges) expect(hits([p.nodes[e.a] as P, ...(e.via ?? []), p.nodes[e.b] as P]), `${tag} ${e.cls} ${e.a}-${e.b} 压门店站点`).toBe(false);
      expect(hits(p.rail), `${tag} 铁路压门店站点`).toBe(false);
      for (const rv of [p.river?.pts ?? [], ...(p.river?.branches ?? [])]) expect(hits(rv), `${tag} 河压门店站点`).toBe(false);
      const sea = seaTester(p);
      for (let i = 0; i <= 8; i++)
        for (let j = 0; j <= 8; j++) {
          const a = poly[0] as P;
          const b = poly[1] as P;
          const d = poly[3] as P;
          expect(sea({ x: a.x + ((b.x - a.x) * i) / 8 + ((d.x - a.x) * j) / 8, y: a.y + ((b.y - a.y) * i) / 8 + ((d.y - a.y) * j) / 8 }), `${tag} 门店站点在海里`).toBe(false);
        }
      // 路口在正前方 1.2–1.5 公里（门前路、货车通道分岔、到路口 22 米）
      expect(l, `${tag} 进店路的路口`).toBeGreaterThan(1.2);
      expect(l, `${tag} 进店路的路口`).toBeLessThan(1.5);
    }
  });

  it('三维里门店店后的收货场有满配的进深（以前只有 30–48 米的几个区域）', () => {
    for (const seed of [3, 4, 6, 8]) {
      setRegion({ mode: 'random', seed });
      const net = new RoadNet();
      const plan = layoutCity(net);
      const site = [...plan.sites.values()][0] as { yard?: { depth: number } };
      expect(site?.yard?.depth ?? 0, `random-${seed} 收货场进深`).toBeGreaterThanOrEqual(85);
    }
  });
});
