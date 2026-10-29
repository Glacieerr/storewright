import { describe, expect, it } from 'vitest';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { buildGeometry } from '../layout';
import { generateSite, type RoadStyle, type SiteLayoutKind } from '../site';
import { boxSdf, harborSdf, lakeSdf, polySdf, riverSdf, riverX, terrainY, waterAt } from './waterPlan';
import { buildTerrain, subtractRects, terrainPatches } from './terrainGeometry';
import { atBerth, boatAt, BOAT_TRAFFIC, CHANNEL_LANE, planBoats, visitorAt, type BoatTraffic } from './harbor';
import type { PathState } from '../lot';

/** 水系与地形（湖、跌水堰、渠道、石拱桥、栈桥）：可复现、不压道路和建筑、桥下有河道、水位关系正确 */

const STYLES: RoadStyle[] = ['suburban', 'urban', 'arterial'];
const LAYOUTS: SiteLayoutKind[] = ['standard', 'corner', 'strip'];

function siteFor(template: 'small' | 'medium' | 'large', style: RoadStyle, seed: number, layout: SiteLayoutKind = 'standard') {
  const geo = buildGeometry(new StoreModel(createTemplate(template)));
  const f0 = geo.floors[0] as (typeof geo.floors)[number];
  const store = { minX: f0.minX, maxX: f0.maxX, minZ: f0.minZ, maxZ: f0.maxZ };
  return { geo, store, site: generateSite({ lot: geo.lot, store, settings: { style, seed, traffic: 1, layout } }) };
}

describe('水系与地形', () => {
  it('同一种子得到同一片水系，不同种子的湖岸形状不同', () => {
    const a = siteFor('medium', 'suburban', 3).site.water;
    const b = siteFor('medium', 'suburban', 3).site.water;
    const c = siteFor('medium', 'suburban', 4).site.water;
    expect(b).toEqual(a);
    expect(JSON.stringify(c.lake.shore)).not.toBe(JSON.stringify(a.lake.shore));
  });

  it('湖在主路对面，不压道路、停车场和门店；建筑和支路都让开水面', () => {
    for (const template of ['small', 'medium', 'large'] as const) {
      for (const style of STYLES) {
        for (const layout of LAYOUTS) {
          for (const seed of [1, 2, 7]) {
            const { site, geo, store } = siteFor(template, style, seed, layout);
            const w = site.water;
            // 整个湖都在远侧人行道之外（−Z 方向）
            for (const p of w.lake.shore) expect(p.z).toBeLessThan(site.roadBottomZ - 2.4 - 4);
            // 湖和河不进停车场、门店和后勤通道
            const lot = geo.lot;
            for (let x = lot.minX; x <= lot.maxX + 7; x += 2) {
              for (let z = lot.edgeZ; z <= store.maxZ + 28; z += 2) expect(waterAt(w, x, z).s).toBeLessThan(0);
            }
            // 建筑离水边至少 2 米
            for (const b of site.buildings) {
              for (const [dx, dz] of [
                [0, 0],
                [-0.5, -0.5],
                [0.5, -0.5],
                [-0.5, 0.5],
                [0.5, 0.5],
              ] as const) {
                expect(waterAt(w, b.x + dx * b.w, b.z + dz * b.d).s).toBeLessThan(-2);
              }
            }
            // 支路（车道和人行道）不压河道
            for (const k of site.intersections) {
              const half = k.half + 2.4;
              for (let z = site.ground.z - site.ground.d / 2; z < site.ground.z + site.ground.d / 2; z += 3) {
                expect(waterAt(w, k.x - half, z).s).toBeLessThan(0);
                expect(waterAt(w, k.x + half, z).s).toBeLessThan(0);
              }
            }
          }
        }
      }
    }
  });

  it('石拱桥跨过渠道：桥下是河床，桥面与路面齐平，两端落在平地上', () => {
    for (const style of STYLES) {
      const { site } = siteFor('medium', style, 1);
      const w = site.water;
      const b = w.bridge;
      const zc = (site.roadTopZ + site.roadBottomZ) / 2;
      expect(b.x0).toBeLessThan(w.river.x - w.river.half);
      expect(b.x1).toBeGreaterThan(w.river.x + w.river.half);
      expect(b.z0).toBeLessThanOrEqual(site.roadBottomZ);
      expect(b.z1).toBeGreaterThanOrEqual(site.roadTopZ);
      expect(b.deckTop).toBeCloseTo(-0.04, 5);
      expect(riverSdf(w.river, w.river.x, zc)).toBeGreaterThan(0);
      expect(terrainY(w, w.river.x, zc)).toBeLessThan(w.river.level - 0.5);
      expect(terrainY(w, b.x0 - 0.5, zc)).toBeCloseTo(w.groundY, 5);
      expect(terrainY(w, b.x1 + 0.5, zc)).toBeCloseTo(w.groundY, 5);
      // 拱顶在桥面以下，拱脚高于水面
      expect(b.crown).toBeLessThan(b.deckTop - 0.3);
      expect(b.spring).toBeGreaterThan(w.river.level);
    }
  });

  it('跌水：河水比湖面（海平面）高，经堰流进湖里；堰在湖与渠道之间；渠道段是直的，之后才蜿蜒', () => {
    const { site } = siteFor('medium', 'suburban', 5);
    const w = site.water;
    expect(w.river.level).toBeGreaterThan(w.lake.level + 0.4);
    expect(w.river.zWeir).toBeCloseTo(w.lake.neck.z1, 5);
    // 堰的上游一侧属于湖（渠口），下游一侧属于河
    expect(lakeSdf(w.lake, w.river.x, w.river.zWeir - 0.5)).toBeGreaterThan(0);
    expect(riverSdf(w.river, w.river.x, w.river.zWeir + 0.5)).toBeGreaterThan(0);
    expect(riverSdf(w.river, w.river.x, w.river.zWeir - 0.5)).toBeLessThan(0);
    for (let z = w.river.zWeir; z < w.river.zCanalEnd; z += 2) expect(riverX(w.river, z)).toBe(w.river.x);
    const far = [...Array(40).keys()].map((k) => riverX(w.river, w.river.zCanalEnd + 40 + k * 3));
    expect(Math.max(...far) - Math.min(...far)).toBeGreaterThan(2);
  });

  it('栈桥：岸上一端在平地，尽头和 T 形平台在湖里，小船都漂在湖面上', () => {
    for (const seed of [1, 2, 3, 9]) {
      const w = siteFor('medium', 'suburban', seed).site.water;
      const p = w.pier;
      expect(terrainY(w, p.x, p.zLand)).toBeCloseTo(w.groundY, 5);
      expect(lakeSdf(w.lake, p.x, p.zEnd)).toBeGreaterThan(3);
      expect(p.deckY).toBeGreaterThan(w.lake.level + 0.5);
      for (const b of p.boats) expect(waterAt(w, b.x, b.z).body).toBe('lake');
      // 广场在平地上、不压湖
      expect(polySdf(w.lake.shore, w.plaza.x, w.plaza.z)).toBeLessThan(-3);
    }
  });

  it('地形网格：细网格覆盖整片水系，其余平地拼满场地；高度不高于地面', () => {
    const { site } = siteFor('medium', 'urban', 2);
    const w = site.water;
    const g = site.ground;
    const patches = terrainPatches(w, g);
    expect(patches.length).toBe(2);
    const rects = subtractRects({ x0: g.x - g.w / 2, x1: g.x + g.w / 2, z0: g.z - g.d / 2, z1: g.z + g.d / 2 }, patches);
    const area = [...patches, ...rects].reduce((a, r) => a + (r.x1 - r.x0) * (r.z1 - r.z0), 0);
    expect(area).toBeCloseTo(g.w * g.d, 3);
    // 湖岸线上的点都落在湖的细网格里
    const lake = patches[0] as (typeof patches)[number];
    for (const p of w.lake.shore) expect(boxSdf(lake, p.x, p.z)).toBeGreaterThan(0);
    const geo = buildTerrain(w, g);
    const pos = geo.getAttribute('position');
    let minY = Infinity;
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getY(i)).toBeLessThanOrEqual(w.groundY + 1e-6);
      minY = Math.min(minY, pos.getY(i));
    }
    expect(minY).toBeLessThan(w.river.level);
  });
});

describe('出海口与船只进出港（决策记录 0019）', () => {
  it('湖经出海水道通到场地前沿的海湾：水道一路都是水、两岸是平地；海湾被场地边缘切开；防波堤在水道口两侧', () => {
    for (const style of STYLES) {
      for (const seed of [1, 4, 8]) {
        const { site } = siteFor('medium', style, seed);
        const w = site.water;
        const o = w.outlet;
        expect(o).toBeDefined();
        if (!o) continue;
        // 水道中线从湖里一直到海湾都是水，水深至少 1.5 米
        for (let z = o.z1; z >= o.bay.cz; z -= 1) {
          expect(harborSdf(w, o.x, z)).toBeGreaterThan(0);
          expect(terrainY(w, o.x, z)).toBeLessThan(w.lake.level - 1.5);
        }
        // 场地前沿切在海湾中间，海湾在场地里
        const gz0 = site.ground.z - site.ground.d / 2;
        expect(gz0).toBeCloseTo(o.bay.cz, 5);
        expect(harborSdf(w, o.bay.cx, gz0 + 1)).toBeGreaterThan(5);
        // 防波堤：一红一绿，夹着水道，伸进海湾
        expect(o.jetties.map((j) => j.light).sort()).toEqual(['green', 'red']);
        for (const j of o.jetties) {
          expect(j.x1 <= o.x - o.half + 0.01 || j.x0 >= o.x + o.half - 0.01).toBe(true);
          expect(j.z0).toBeLessThan(o.z0);
        }
        // 建筑、支路都不压水道和海湾
        for (const b of site.buildings) expect(harborSdf(w, b.x, b.z)).toBeLessThan(-2);
        for (const k of site.intersections) for (let z = gz0; z < site.roadBottomZ; z += 3) expect(harborSdf(w, k.x, z)).toBeLessThan(0);
      }
    }
  });

  it('船只时刻表：快艇、小帆船早上出海、下午回港，浮筒船在湖里兜圈；航线一直在水里，出港驶出场地边缘、回港靠上泊位', () => {
    const { site } = siteFor('medium', 'suburban', 3);
    const w = site.water;
    const s = planBoats(w, 3);
    expect(s.legs.filter((l) => l.kind === 'out').length).toBeGreaterThanOrEqual(2);
    expect(s.legs.filter((l) => l.kind === 'in').length).toBe(s.legs.filter((l) => l.kind === 'out').length);
    expect(s.legs.some((l) => l.kind === 'cruise')).toBe(true);
    const p: PathState = { x: 0, z: 0, heading: 0 };
    for (const leg of s.legs) {
      const boat = w.pier.boats[leg.berth];
      expect(boat).toBeDefined();
      if (!boat) continue;
      for (let t = 0; t <= leg.path.duration; t += 1) {
        leg.path.at(t, p);
        // 场地边缘以内的航线都在水里（泊位附近贴着栈桥除外）
        if (p.z < w.minZ + 1 || Math.hypot(p.x - boat.x, p.z - boat.z) < 4) continue;
        expect(waterAt(w, p.x, p.z).s, `${leg.kind} ${t}`).toBeGreaterThan(0.8);
      }
      leg.path.at(leg.path.duration, p);
      if (leg.kind === 'out') expect(p.z).toBeLessThan(w.minZ);
      else {
        expect(Math.hypot(p.x - boat.x, p.z - boat.z)).toBeLessThan(0.05);
        // 靠上泊位时船头朝向就是系泊的朝向（不会一下子转过去）
        let d = p.heading - boat.heading;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        expect(Math.abs(d)).toBeLessThan(0.08);
      }
    }
    // 出海期间泊位是空的；夜里都在泊位上
    const out = s.legs.find((l) => l.kind === 'out');
    if (out) {
      expect(atBerth(s, out.berth, out.start + out.path.duration + 600)).toBe(false);
      expect(boatAt(s, out.berth, out.start + 10, p)?.leg).toBe(out);
      // 高倍速时一程按画面拉长：同一时刻走得没那么远
      expect(boatAt(s, out.berth, out.start + out.path.duration * 2, p, 4)?.leg).toBe(out);
      expect(atBerth(s, out.berth, 3 * 3600)).toBe(true);
    }
  });

  it('没有水面：没有湖、河和出海口，地面是平的，场地前沿收近一些', () => {
    const geo = buildGeometry(new StoreModel(createTemplate('medium')));
    const f0 = geo.floors[0] as (typeof geo.floors)[number];
    const store = { minX: f0.minX, maxX: f0.maxX, minZ: f0.minZ, maxZ: f0.maxZ };
    const dry = generateSite({ lot: geo.lot, store, settings: { style: 'suburban', seed: 1, traffic: 1, water: 'none' } });
    const wet = generateSite({ lot: geo.lot, store, settings: { style: 'suburban', seed: 1, traffic: 1 } });
    expect(dry.water.enabled).toBe(false);
    expect(dry.water.outlet).toBeUndefined();
    for (let x = dry.ground.x - dry.ground.w / 2; x < dry.ground.x + dry.ground.w / 2; x += 7) for (let z = dry.ground.z - dry.ground.d / 2; z < dry.ground.z + dry.ground.d / 2; z += 7) expect(terrainY(dry.water, x, z)).toBe(dry.water.groundY);
    expect(dry.ground.d).toBeLessThan(wet.ground.d);
    expect(planBoats(dry.water, 1).legs).toHaveLength(0);
    // 场地只到周边一圈：左右各离停车场 110 米
    expect(wet.ground.w).toBeCloseTo(geo.lot.maxX - geo.lot.minX + 220, 5);
  });
});

describe('船只多少与避让（决策记录 0020）', () => {
  const LEVELS: BoatTraffic[] = ['few', 'normal', 'many'];

  it('船只越多：栈桥的船跑的趟数、访客船、海湾里经过的船都更多；访客船和经过的船的航线一直在水里', () => {
    for (const seed of [3, 11]) {
      const { site } = siteFor('medium', 'suburban', seed);
      const w = site.water;
      const counts = LEVELS.map((lv) => {
        const s = planBoats(w, seed, lv);
        return s.legs.length + s.visitors.length;
      });
      expect(counts[0]).toBeLessThan(counts[1] as number);
      expect(counts[1]).toBeLessThan(counts[2] as number);
      const many = planBoats(w, seed, 'many');
      expect(many.legs.filter((l) => l.kind === 'out').length).toBeGreaterThan(planBoats(w, seed, 'normal').legs.filter((l) => l.kind === 'out').length);
      expect(many.visitors.filter((v) => v.leg.kind === 'visit').length).toBeGreaterThanOrEqual(BOAT_TRAFFIC.many.visitors - 1);
      expect(many.visitors.filter((v) => v.leg.kind === 'pass').length).toBeGreaterThanOrEqual(BOAT_TRAFFIC.many.passers - 2);
      const p: PathState = { x: 0, z: 0, heading: 0 };
      for (const v of many.visitors) {
        for (let t = 0; t <= v.leg.path.duration; t += 1) {
          v.leg.path.at(t, p);
          if (p.z < w.minZ + 1) continue;
          expect(waterAt(w, p.x, p.z).s, `${v.leg.kind} ${t}`).toBeGreaterThan(0.8);
        }
        // 从场地边缘外来、驶出场地边缘
        v.leg.path.at(0, p);
        expect(p.z).toBeLessThan(w.minZ);
        v.leg.path.at(v.leg.path.duration, p);
        expect(p.z).toBeLessThan(w.minZ);
      }
    }
  });

  it('出海水道里出海的走一边、回港的走另一边（各自靠右）', () => {
    const { site } = siteFor('medium', 'suburban', 3);
    const w = site.water;
    const o = w.outlet!;
    const s = planBoats(w, 3, 'many');
    const p: PathState = { x: 0, z: 0, heading: 0 };
    const mid = (o.z0 + o.z1) / 2;
    const at = (path: { duration: number; at: (t: number, out: PathState) => void }) => {
      // 走到水道中段时离中线多远
      for (let t = 0; t <= path.duration; t += 0.25) {
        path.at(t, p);
        if (Math.abs(p.z - mid) < 0.6) return p.x - o.x;
      }
      return undefined;
    };
    for (const leg of s.legs.filter((l) => l.kind === 'out' || l.kind === 'in')) {
      const dx = at(leg.path);
      expect(dx).toBeDefined();
      expect(Math.sign(dx as number)).toBe(leg.kind === 'out' ? 1 : -1);
      expect(Math.abs(dx as number)).toBeCloseTo(CHANNEL_LANE, 0);
    }
  });

  it('任何播放速度下（画面拉长 1–12 倍）行驶中的船之间都隔开 4 米以上', () => {
    for (const seed of [3, 7]) {
      const { site } = siteFor('medium', 'suburban', seed);
      const w = site.water;
      const s = planBoats(w, seed, 'many');
      const p: PathState = { x: 0, z: 0, heading: 0 };
      for (const f of [1, 7.5, 12]) {
        for (let t = 6 * 3600; t < 21 * 3600; t += 5) {
          const pos: Array<{ x: number; z: number }> = [];
          w.pier.boats.forEach((_, i) => {
            if (atBerth(s, i, t, f)) return;
            const hit = boatAt(s, i, t, p, f);
            if (hit && p.z > w.minZ) pos.push({ x: p.x, z: p.z });
          });
          for (const v of s.visitors) if (visitorAt(v, t, p, f) !== undefined && p.z > w.minZ) pos.push({ x: p.x, z: p.z });
          for (let a = 0; a < pos.length; a++)
            for (let b = a + 1; b < pos.length; b++) expect(Math.hypot((pos[a] as { x: number }).x - (pos[b] as { x: number }).x, (pos[a] as { z: number }).z - (pos[b] as { z: number }).z), `seed ${seed} f ${f} t ${t}`).toBeGreaterThan(4);
        }
      }
    }
  });
});

