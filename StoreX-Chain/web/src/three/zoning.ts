import * as THREE from 'three';
import { currentRegion } from '../../../src/region/network';
import { DIORAMA_SCALE, RAIL } from '../../../src/region/region';
import { pointInPoly, rand, sampleAt, SegGrid, segIntersect, v3, type V3 } from './geo';
import { buildCityscape } from './cityscape';
import { L, landAt, planLandUse, type LandUsePlan } from '../../../src/region/landuse';
import { halfAll, type Line, type RoadNet } from './roadnet';
import type { Site } from './stores';

/**
 * 城区（轻量背景）：区域生成器给的城区边界以内摆简单的建筑体量——每 74 米一个地块，
 * 楼的朝向跟最近的干道走，离城市中心越近越高，统一的浅灰米色；散布几片公园（只种树）。
 * 让开道路、路口、门店、铁路、河、高架和设施。干道围成的街区里铺一层小街（planStreets），沿小街摆小区停车场。
 */
type Pt = { x: number; z: number };

export interface ZonePlan {
  /** 不能盖房的地方：环岛、立交、路口、门店站点、进店路 */
  exclude: (x: number, z: number, pad: number) => boolean;
  /** 城区范围（区域生成器给的城区边界以内，离海、河、铁路有一段距离） */
  inside: (x: number, z: number) => boolean;
  /** 城市中心（沙盘米） */
  centers: Pt[];
  /** 后来摆的东西（小区停车场）也不能盖房：外扩 pad 米 */
  addArea: (poly: readonly Pt[], pad: number) => void;
}

export function planZoning(net: RoadNet, sites: Map<string, Site>, extra: readonly { x: number; z: number }[][] = []): ZonePlan {
  const plan = currentRegion();
  const circles: { c: Pt; r: number }[] = [];
  for (const id of plan.city.nodes) {
    const j = net.junctions.get(id);
    if (j) circles.push({ c: { x: j.pos.x, z: j.pos.z }, r: j.kind === 'roundabout' ? 110 : 40 });
  }
  const ring = net.lines[net.ringLine] as Line;
  for (const ic of net.ics.values()) {
    const p = ring.pts[Math.max(0, ring.cum.findIndex((c) => c >= ic.s))] as V3;
    circles.push({ c: { x: p.x, z: p.z }, r: 198 });
  }
  // 门店站点和停车场（extra）：外扩 24 米
  const outlines: Pt[][] = [...[...sites.values()].map((s) => s.outline), ...extra].map((ol) => {
    const c = { x: ol.reduce((a, p) => a + p.x, 0) / ol.length, z: ol.reduce((a, p) => a + p.z, 0) / ol.length };
    return ol.map((p) => {
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const l = Math.hypot(dx, dz) || 1;
      return { x: p.x + (dx / l) * 24, z: p.z + (dz / l) * 24 };
    });
  });
  const grid = new SegGrid(40, 12);
  for (const o of outlines) grid.add([...o, o[0] as Pt], 0);
  const addArea = (poly: readonly Pt[], pad: number) => {
    const c = { x: poly.reduce((a, p) => a + p.x, 0) / poly.length, z: poly.reduce((a, p) => a + p.z, 0) / poly.length };
    outlines.push(
      poly.map((p) => {
        const dx = p.x - c.x;
        const dz = p.z - c.z;
        const l = Math.hypot(dx, dz) || 1;
        return { x: p.x + (dx / l) * pad, z: p.z + (dz / l) * pad };
      }),
    );
  };
  for (const l of net.lines.filter((x) => x.cls === 'local')) grid.add(l.pts, halfAll(l.xs) + 3);
  // 让开的线：绕城快速路、高架、铁路、河（河两岸留出滨河绿地）
  const keep = new SegGrid(60, 16);
  keep.add(ring.pts, 0);
  for (const l of net.lines.filter((x) => x.cls === 'elevated')) keep.add(l.pts, 0);
  const wide = new SegGrid(60, 16);
  wide.add(RAIL.map((k) => ({ x: k.x * DIORAMA_SCALE, y: 0, z: -k.y * DIORAMA_SCALE }) as V3), 0);
  const riverHalf = plan.river ? (plan.river.width * DIORAMA_SCALE) / 2 : 0;
  if (plan.river) for (const l of [plan.river.pts, ...(plan.river.branches ?? [])]) wide.add(l.map((k) => ({ x: k.x * DIORAMA_SCALE, y: 0, z: -k.y * DIORAMA_SCALE }) as V3), 0);
  const cityPoly = plan.city.boundary.map((k) => ({ x: k.x * DIORAMA_SCALE, z: -k.y * DIORAMA_SCALE }));
  return {
    exclude: (x, z, pad) => circles.some((c) => Math.hypot(x - c.c.x, z - c.c.z) < c.r + pad) || outlines.some((o) => pointInPoly(x, z, o)) || grid.near(x, z, pad),
    inside: (x, z) => pointInPoly(x, z, cityPoly) && !keep.near(x, z, 60) && !wide.near(x, z, Math.max(45, riverHalf + 40)),
    centers: plan.city.centers.map((c) => ({ x: c.x * DIORAMA_SCALE, z: -c.y * DIORAMA_SCALE })),
    addArea,
  };
}

/**
 * 城区的小街：干道围成的大街区里铺一层方格小街（双向两车道、路边一条停车带、两侧人行道、一侧路灯、行道树）。
 * 方格的方向跟着干道走：城区里干道的主要方向（按长度统计、模 90 度）有一到三个，每个地方用离它最近的干道所属的那个方向，
 * 各个方向分别铺一遍（自由生长、放射形、带状的城区各片的方格方向不一样，小一点、不规则的城区也铺得满）。
 * 间距 165 米左右（按公开资料：支路间距宜 150–250 米、不超过 300 米）；工业、物流用地隔一条铺一条（街区大一些），
 * 大学、公用设施、公交和货运场站、大片的公园里不铺。
 * 一条格线在街区里能铺的那一段（在城区里、离开干道、门店、停车场、铁路、河、高架）就是一条小街，两头伸到干道
 *（或者先铺好的小街）上接成 T 形路口（小街让干道），格线相交的地方是十字路口；
 * 伸不到干道的一头：离最近的路口不远就截掉，远就做成带回车场的尽头路（只有这种尽头路，没有断头路）；接不到干道的整片不铺。
 * 干道上的 T 形路口彼此隔开、离停车场门口远一点，也不开在公交站的港湾上（keepClear：没有小街时排出来的站，连前后排队的路段）。
 * 在 net.finalize 之前调（小街要算进路口）；网页（world.ts）、车流线程（trafficWorker.ts）和测试都经 cityplan.ts 按同样的顺序调。
 */
export interface StreetPlan {
  lines: Line[];
  /** 尽头路（带回车场）的条数、十字和丁字路口数、接到干道上的路口数 */
  culs: number;
  crossings: number;
  tees: number;
}

export function planStreets(net: RoadNet, plan: ZonePlan, keepClear: readonly { line: number; s0: number; s1: number }[] = []): StreetPlan {
  const region = currentRegion();
  const r = rand(7717 + region.spec.seed * 29 + region.spec.mode.length * 5);
  const city = region.city.boundary.map((k) => ({ x: k.x * DIORAMA_SCALE, z: -k.y * DIORAMA_SCALE }));
  const lu = planLandUse(region);
  const landOf = (x: number, z: number) => landAt(lu, { x: x / DIORAMA_SCALE, y: -z / DIORAMA_SCALE });
  /** 用地不让铺小街的地方：大学、公用设施、场站、大片公园；工业、物流用地隔一条铺一条 */
  const landOk = (x: number, z: number, odd: boolean): boolean => {
    const c = landOf(x, z);
    if (c === L.A31 || c === L.U1 || c === L.U2 || c === L.S4 || c === L.WATER) return false;
    if (c === L.G1 && [-26, 26].every((dx) => [-26, 26].every((dz) => landOf(x + dx, z + dz) === L.G1))) return false;
    if (odd && (c === L.M1 || c === L.M2 || c === L.W1 || c === L.W2)) return false;
    return true;
  };
  const SP = 165;
  const STEP = 4;
  const SW = halfAll({ lanes: 1, laneW: 3.25, median: 0, inner: 0, outer: 2, walk: 2.2 } as Line['xs']);
  const roads = new SegGrid(50, 30);
  for (const l of net.lines) roads.add(l.pts, halfAll(l.xs));
  const CLR = SW + 7;
  const made: Line[] = [];
  const ids = new Map<string, string>();
  const tees: V3[] = [];
  let culs = 0;
  let nCross = 0;
  let nTee = 0;
  let k = 0;
  // 停车场门口的 T 形路口：公交的首末站、门口的站摆在它前后的路上，小街离远一点
  const doors = [...net.junctions.values()].filter((j) => j.kind === 'mid' && j.id.endsWith(':t')).map((j) => j.pos);

  // —— 街区：城区里能铺小街的空地（10 米一格）按连通分成一块块（被路隔开），每块按围着它的路定方格的方向 ——
  const G = 10;
  let bx0 = Infinity;
  let bx1 = -Infinity;
  let bz0 = Infinity;
  let bz1 = -Infinity;
  for (const p of city) [bx0, bx1, bz0, bz1] = [Math.min(bx0, p.x), Math.max(bx1, p.x), Math.min(bz0, p.z), Math.max(bz1, p.z)];
  const gw = Math.ceil((bx1 - bx0) / G) + 1;
  const gh = Math.ceil((bz1 - bz0) / G) + 1;
  const comp = new Int32Array(gw * gh).fill(-1);
  const freeCell = new Uint8Array(gw * gh);
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      const x = bx0 + (i + 0.5) * G;
      const z = bz0 + (j + 0.5) * G;
      if (pointInPoly(x, z, city) && plan.inside(x, z) && !plan.exclude(x, z, 8) && !roads.near(x, z, CLR)) freeCell[j * gw + i] = 1;
    }
  const blocks: { cells: number[]; ang: number }[] = [];
  for (let s0 = 0; s0 < gw * gh; s0++) {
    if (!freeCell[s0] || (comp[s0] as number) >= 0) continue;
    const id = blocks.length;
    const cells: number[] = [];
    const stack = [s0];
    comp[s0] = id;
    while (stack.length) {
      const c = stack.pop() as number;
      cells.push(c);
      const ci = c % gw;
      const cj = Math.floor(c / gw);
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= gw || nj >= gh) continue;
        const n = nj * gw + ni;
        if (!freeCell[n] || (comp[n] as number) >= 0) continue;
        comp[n] = id;
        stack.push(n);
      }
    }
    blocks.push({ cells, ang: 0 });
  }
  // 每块的方向：块边上的格子离最近的那段路的方向（模 90 度，5 度一档）按长度统计，取最多的
  const OB = 60;
  const segGrid = new Map<string, { x: number; z: number; a: number }[]>();
  for (const l of net.lines) {
    if (l.cls !== 'arterial' && l.cls !== 'local' && l.cls !== 'ring' && l.cls !== 'highway') continue;
    for (let i = 1; i < l.pts.length; i++) {
      const p = l.pts[i - 1] as V3;
      const q = l.pts[i] as V3;
      const w = Math.hypot(q.x - p.x, q.z - p.z);
      const a = (((Math.atan2(q.z - p.z, q.x - p.x) * 180) / Math.PI) % 90 + 90) % 90;
      for (let t = 0; t < w; t += 20) {
        const sg = { x: p.x + ((q.x - p.x) * t) / w, z: p.z + ((q.z - p.z) * t) / w, a };
        const key = `${Math.floor(sg.x / OB)},${Math.floor(sg.z / OB)}`;
        const list = segGrid.get(key) ?? [];
        list.push(sg);
        segGrid.set(key, list);
      }
    }
  }
  const roadAng = (x: number, z: number): number | undefined => {
    const cx = Math.floor(x / OB);
    const cz = Math.floor(z / OB);
    let bd = 90;
    let ba: number | undefined;
    for (let i = cx - 1; i <= cx + 1; i++)
      for (let kk = cz - 1; kk <= cz + 1; kk++)
        for (const sg of segGrid.get(`${i},${kk}`) ?? []) {
          const d = Math.hypot(sg.x - x, sg.z - z);
          if (d < bd) [bd, ba] = [d, sg.a];
        }
    return ba;
  };
  for (const blk of blocks) {
    const hist = new Float64Array(18);
    for (const c of blk.cells) {
      const ci = c % gw;
      const cj = Math.floor(c / gw);
      const edge = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([di, dj]) => {
        const ni = ci + (di as number);
        const nj = cj + (dj as number);
        return ni < 0 || nj < 0 || ni >= gw || nj >= gh || !freeCell[nj * gw + ni];
      });
      if (!edge) continue;
      const a = roadAng(bx0 + (ci + 0.5) * G, bz0 + (cj + 0.5) * G);
      if (a === undefined) continue;
      hist[Math.floor(a / 5) % 18] = (hist[Math.floor(a / 5) % 18] as number) + 1;
    }
    let bi = 0;
    for (let i = 1; i < 18; i++) if ((hist[i] as number) + (hist[(i + 17) % 18] as number) * 0.5 + (hist[(i + 1) % 18] as number) * 0.5 > (hist[bi] as number) + (hist[(bi + 17) % 18] as number) * 0.5 + (hist[(bi + 1) % 18] as number) * 0.5) bi = i;
    blk.ang = bi * 5 + 2.5;
  }
  const cellOf = (x: number, z: number) => {
    const i = Math.floor((x - bx0) / G);
    const j = Math.floor((z - bz0) / G);
    return i < 0 || j < 0 || i >= gw || j >= gh ? -1 : (comp[j * gw + i] as number);
  };

  for (const [pi, blk] of blocks.entries()) {
    // 太小的街区不铺
    if (blk.cells.length * G * G < 11000) continue;
    const deg = blk.ang;
    const th = (deg * Math.PI) / 180;
    const U = { x: Math.cos(th), z: Math.sin(th) };
    const V = { x: -Math.sin(th), z: Math.cos(th) };
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const c of blk.cells) {
      const x = bx0 + ((c % gw) + 0.5) * G;
      const z = bz0 + (Math.floor(c / gw) + 0.5) * G;
      const pu = x * U.x + z * U.z;
      const pv = x * V.x + z * V.z;
      [u0, u1, v0, v1] = [Math.min(u0, pu), Math.max(u1, pu), Math.min(v0, pv), Math.max(v1, pv)];
    }
    const free = (x: number, z: number, odd: boolean) => cellOf(x, z) === pi && !roads.near(x, z, CLR) && landOk(x, z, odd);
    const at = (dir: number, c: number, t: number): Pt => {
      const D = dir === 0 ? U : V;
      const N = dir === 0 ? V : U;
      return { x: N.x * c + D.x * t, z: N.z * c + D.z * t };
    };
    /** 从 p0 沿 d 走 len 米最先碰到的线 */
    const firstHit = (p0: Pt, d: Pt, len: number): { line: Line; t: number; s: number; p: V3; dx: number; dz: number } | undefined => {
      const p1 = { x: p0.x + d.x * len, z: p0.z + d.z * len };
      let best: { line: Line; t: number; s: number; p: V3; dx: number; dz: number } | undefined;
      for (const l of net.lines) {
        for (let i = 1; i < l.pts.length; i++) {
          const a = l.pts[i - 1] as V3;
          const c = l.pts[i] as V3;
          if (Math.max(a.x, c.x) < Math.min(p0.x, p1.x) || Math.min(a.x, c.x) > Math.max(p0.x, p1.x) || Math.max(a.z, c.z) < Math.min(p0.z, p1.z) || Math.min(a.z, c.z) > Math.max(p0.z, p1.z)) continue;
          const h = segIntersect(p0, p1, a, c);
          if (!h || (best && h.t * len >= best.t)) continue;
          const sl = Math.hypot(c.x - a.x, c.z - a.z) || 1;
          best = { line: l, t: h.t * len, s: (l.cum[i - 1] as number) + h.u * sl, p: v3(p0.x + d.x * h.t * len, 0, p0.z + d.z * h.t * len), dx: (c.x - a.x) / sl, dz: (c.z - a.z) / sl };
        }
      }
      return best;
    };
    const junctions = [...net.junctions.values()];

    // 1）格线上能铺的段
    interface End {
      t: number;
      tee?: { line: Line; s: number; p: V3 };
    }
    interface Run {
      dir: number;
      c: number;
      a: End;
      b: End;
      nodes: { t: number; key: string }[];
      keep: boolean;
    }
    const runs: Run[] = [];
    for (const dir of [0, 1]) {
      const [c0, c1] = dir === 0 ? [v0, v1] : [u0, u1];
      const [t0, t1] = dir === 0 ? [u0, u1] : [v0, v1];
      // 线在街区里均匀排开（街区宽 W 就排 round(W / 间距) 条，至少一条，中间那条正好把街区分成两半）
      const nLines = Math.max(1, Math.round((c1 - c0) / SP));
      if (c1 - c0 < 80) continue;
      const jit = (r() - 0.5) * 12;
      let li = 0;
      for (let c = c0 + (c1 - c0) / (nLines + 1) + jit; li < nLines; c += (c1 - c0) / (nLines + 1), li++) {
        let start = NaN;
        for (let t = t0; t <= t1 + STEP; t += STEP) {
          const p = at(dir, c, t);
          const ok = t <= t1 && free(p.x, p.z, li % 2 === 1);
          if (ok && Number.isNaN(start)) start = t;
          if (!ok && !Number.isNaN(start)) {
            if (t - STEP - start >= 50) runs.push({ dir, c, a: { t: start }, b: { t: t - STEP }, nodes: [], keep: true });
            start = NaN;
          }
        }
      }
    }
    // 2）两头伸到干道（或者先铺好的小街）上：夹角不太斜、离别的路口和停车场门口够远
    const teeOk = (p: V3) => !junctions.some((j) => Math.hypot(j.pos.x - p.x, j.pos.z - p.z) < 60) && !tees.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 70) && !doors.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 120);
    for (const run of runs)
      for (const [end, sgn] of [
        [run.a, -1],
        [run.b, 1],
      ] as const) {
        const D = run.dir === 0 ? U : V;
        const d = { x: D.x * sgn, z: D.z * sgn };
        const p0 = at(run.dir, run.c, end.t);
        const hit = firstHit(p0, d, CLR + 70);
        if (!hit || (hit.line.cls !== 'arterial' && hit.line.cls !== 'street') || hit.line.elev(hit.s) > 0.3 || hit.line.bridges.some((br) => hit.s > br.s0 - 30 && hit.s < br.s1 + 30)) continue;
        if (Math.abs(hit.dx * d.x + hit.dz * d.z) > 0.7 || hit.s < 30 || hit.s > hit.line.len - 30) continue;
        // 伸过去的那一段也要在城区里、不进门店停车场
        let clear = true;
        for (let t = 4; t < hit.t - halfAll(hit.line.xs); t += 4) {
          const x = p0.x + d.x * t;
          const z = p0.z + d.z * t;
          if (!pointInPoly(x, z, city) || plan.exclude(x, z, 2)) clear = false;
        }
        // 公交站的港湾（连前后排队的路段）上不开路口
        if (!clear || keepClear.some((zc) => zc.line === hit.line.id && hit.s > zc.s0 && hit.s < zc.s1) || !teeOk(hit.p)) continue;
        tees.push(hit.p);
        end.tee = { line: hit.line, s: hit.s, p: hit.p };
        end.t += sgn * hit.t;
      }
    // 3）格线相交的地方（两条段都铺到了这里）
    const cross: { a: Run; b: Run; ta: number; tb: number; key: string; keep: boolean }[] = [];
    for (const a of runs) {
      if (a.dir !== 0) continue;
      for (const b of runs) {
        if (b.dir !== 1) continue;
        // a 沿 U、偏移 V = a.c；b 沿 V、偏移 U = b.c：交点在 a 上的 t = b.c，在 b 上的 t = a.c
        const ta = b.c;
        const tb = a.c;
        if (ta < Math.min(a.a.t, a.b.t) || ta > Math.max(a.a.t, a.b.t) || tb < Math.min(b.a.t, b.b.t) || tb > Math.max(b.a.t, b.b.t)) continue;
        cross.push({ a, b, ta, tb, key: `${pi}x${cross.length}`, keep: true });
      }
    }
    // 路口彼此至少隔 40 米（离 T 形路口、尽头近的十字路口不要）
    const nodeT = (run: Run) => [run.a.t, run.b.t];
    for (const x of cross) {
      const nearX = (run: Run, t: number) => nodeT(run).some((e) => Math.abs(e - t) < 40) || cross.some((y) => y !== x && y.keep && ((y.a === run && Math.abs(y.ta - t) < 40) || (y.b === run && Math.abs(y.tb - t) < 40)));
      if (nearX(x.a, x.ta) || nearX(x.b, x.tb)) x.keep = false;
    }
    for (const x of cross)
      if (x.keep) {
        x.a.nodes.push({ t: x.ta, key: x.key });
        x.b.nodes.push({ t: x.tb, key: x.key });
      }
    // 4）伸不到干道的头：离最近的路口不到 70 米就截到那个路口，远就做尽头路（回车场往回收 14 米）
    for (const run of runs) {
      run.nodes.sort((p, q) => p.t - q.t);
      const first = run.nodes[0];
      const last = run.nodes[run.nodes.length - 1];
      if (!run.a.tee) {
        if (first && first.t - run.a.t < 70) run.a.t = first.t;
        else run.a.t += 14;
      }
      if (!run.b.tee) {
        if (last && run.b.t - last.t < 70) run.b.t = last.t;
        else run.b.t -= 14;
      }
      if (run.b.t - run.a.t < 40) run.keep = false;
    }
    // 5）只留接得到干道的（从 T 形路口沿小街、十字路口走得到）
    const adj = new Map<Run, Run[]>();
    for (const x of cross) {
      if (!x.keep || !x.a.keep || !x.b.keep) continue;
      adj.set(x.a, [...(adj.get(x.a) ?? []), x.b]);
      adj.set(x.b, [...(adj.get(x.b) ?? []), x.a]);
    }
    const reach = new Set<Run>();
    const queue = runs.filter((x) => x.keep && (x.a.tee || x.b.tee));
    for (const x of queue) reach.add(x);
    while (queue.length) {
      const x = queue.pop() as Run;
      for (const y of adj.get(x) ?? [])
        if (!reach.has(y)) {
          reach.add(y);
          queue.push(y);
        }
    }
    for (const run of runs) if (!reach.has(run)) run.keep = false;
    // 6）铺：路口、每两个相邻路口之间一条小街
    const crossId = (key: string, p: Pt): string => {
      let id = ids.get(key);
      if (!id) {
        id = `ST${ids.size}:x`;
        net.junction(id, v3(p.x, 0, p.z), 'grade', false);
        ids.set(key, id);
        nCross++;
      }
      return id;
    };
    for (const run of runs) {
      if (!run.keep) continue;
      const list: { t: number; id: string; p: V3 }[] = [];
      const endNode = (e: End, tag: string): { t: number; id: string; p: V3 } => {
        const p = at(run.dir, run.c, e.t);
        if (e.tee) {
          nTee++;
          return { t: e.t, id: net.addMid(e.tee.line, e.tee.s, `ST${k}:${tag}`, 'mid', false), p: e.tee.p.clone() };
        }
        // 正好截到十字路口
        const hitX = run.nodes.find((n) => Math.abs(n.t - e.t) < 0.5);
        if (hitX) return { t: e.t, id: crossId(hitX.key, p), p: v3(p.x, 0, p.z) };
        culs++;
        const id = `ST${k}:${tag}`;
        net.junction(id, v3(p.x, 0, p.z), 'end', false, { bulb: true });
        return { t: e.t, id, p: v3(p.x, 0, p.z) };
      };
      list.push(endNode(run.a, 'a'));
      for (const n of run.nodes) {
        if (n.t <= run.a.t + 0.5 || n.t >= run.b.t - 0.5) continue;
        const x = cross.find((c) => c.key === n.key);
        if (!x || !x.keep || !x.a.keep || !x.b.keep) continue;
        const p = at(run.dir, run.c, n.t);
        list.push({ t: n.t, id: crossId(n.key, p), p: v3(p.x, 0, p.z) });
      }
      list.push(endNode(run.b, 'b'));
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1] as { id: string; p: V3 };
        const b = list[i] as { id: string; p: V3 };
        const line = net.addLine('street', [a.p.clone(), b.p.clone()], a.id, b.id, { name: '小街' });
        made.push(line);
        roads.add(line.pts, halfAll(line.xs));
      }
      k++;
    }
  }
  return { lines: made, culs, crossings: nCross, tees: nTee };
}

/**
 * 小街路边的停车位：每条小街两侧各有三成机会划一段（行车道外侧的停车带上，6.2 米一个，车头朝这一侧的行车方向），
 * 让开路口、斑马线和小区停车场的进出口。在 net.finalize 之后调（要用路口退让的距离）；住户的车整天停在这里（traffic.ts）。
 */
export function planCurbs(net: RoadNet): void {
  const region = currentRegion();
  const r = rand(3301 + region.spec.seed * 19);
  const curbs: RoadNet['curbs'] = [];
  for (const line of net.lines) {
    if (line.cls !== 'street') continue;
    const xs = line.xs;
    const off = xs.median / 2 + xs.inner + xs.lanes * xs.laneW + 1.0;
    const s0 = line.trimA + 9;
    const s1 = line.len - line.trimB - 9;
    for (const side of [1, -1]) {
      if (r() > 0.32) continue;
      for (let s = s0 + 3.1; s + 3.1 <= s1; s += 6.2) {
        if (line.mids.some((m) => Math.abs(m.s - s) < 12)) continue;
        const pt = (u: number) => {
          const q = sampleAt(line.pts, line.cum, u);
          return v3(q.p.x - q.dz * off * side, 0, q.p.z + q.dx * off * side);
        };
        const rear = pt(s - 2.4 * side);
        const front = pt(s + 2.4 * side);
        curbs.push({ a: rear, b: front, line: line.id });
      }
    }
  }
  net.curbs = everyOther(curbs);
}

export interface Zoning {
  group: THREE.Group;
  /** 夜里楼体稍微亮一点、窗户亮灯（hour：几点，深夜亮的窗户少） */
  setNight: (night: number, hour?: number) => void;
  /** 建筑数 */
  buildings: number;
  /** 用地规划（规划图、标签用） */
  landuse: LandUsePlan;
}

/** 城区和设施周边的建筑：按用地规划摆（cityscape.ts） */
export function buildZoning(plan: ZonePlan, net: RoadNet, corridors: { pts: V3[]; hw: number }[]): Zoning {
  return buildCityscape({ inside: plan.inside, exclude: plan.exclude, centers: plan.centers }, net, corridors);
}

/**
 * 小街路边的车位一排隔一个用一个（车位之间只空 1.4 米：顺着车道倒进车位、开出来的时候车头要扫过前面那个车位，
 * 前面停着车就会蹭上；隔一个以后中间空出 7.6 米）。按划车位的先后，一排挨着的车位里留下第 0、2、4… 个（车位 12.4 米一个）
 */
function everyOther(curbs: RoadNet['curbs']): RoadNet['curbs'] {
  const out: RoadNet['curbs'] = [];
  let prev: RoadNet['curbs'][number] | undefined;
  let k = 0;
  for (const c of curbs) {
    const next = !!prev && prev.line === c.line && (Math.hypot(c.a.x - prev.b.x, c.a.z - prev.b.z) < 2.5 || Math.hypot(c.b.x - prev.a.x, c.b.z - prev.a.z) < 2.5);
    k = next ? k + 1 : 0;
    prev = c;
    if (k % 2 === 0) out.push(c);
  }
  return out;
}
