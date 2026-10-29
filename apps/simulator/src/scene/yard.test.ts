import { describe, expect, it } from 'vitest';
import { backroomLayout, createTemplate, StoreModel } from '@storewright/store-config';
import { buildGeometry } from './layout';
import { generateSite, type RoadStyle, type YardAccess } from './site';
import type { PathState } from './lot';
import { lanePose, laneDrive, QueueMotion, queueTargets, yardRoute } from './yard';
import { SEMI } from './vehicleTypes';
import type { RigPose } from './rig';

const ang = (a: number, b: number) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

/** 有朝向的矩形：中心、半长（沿航向）、半宽、航向 */
interface OBB {
  x: number;
  z: number;
  hl: number;
  hw: number;
  h: number;
}

/** 分离轴判断两个有朝向的矩形是否相交（留 margin 米的余量） */
function intersects(a: OBB, b: OBB, margin = 0): boolean {
  const axes = [a.h, a.h + Math.PI / 2, b.h, b.h + Math.PI / 2];
  const corners = (r: OBB) => {
    const f = { x: Math.sin(r.h), z: Math.cos(r.h) };
    const s = { x: Math.cos(r.h), z: -Math.sin(r.h) };
    return [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ].map(([u, v]) => ({ x: r.x + f.x * (u as number) * r.hl + s.x * (v as number) * r.hw, z: r.z + f.z * (u as number) * r.hl + s.z * (v as number) * r.hw }));
  };
  const ca = corners(a);
  const cb = corners(b);
  for (const t of axes) {
    const ax = { x: Math.sin(t), z: Math.cos(t) };
    const pa = ca.map((p) => p.x * ax.x + p.z * ax.z);
    const pb = cb.map((p) => p.x * ax.x + p.z * ax.z);
    if (Math.max(...pa) + margin < Math.min(...pb) || Math.max(...pb) + margin < Math.min(...pa)) return false;
  }
  return true;
}

/** 半挂车的两个矩形：挂车（牵引销前 0.95 米到后 15.25 米）、牵引车（牵引销后 1.3 米到前 6.4 米） */
function rigBoxes(p: RigPose): OBB[] {
  const tl = (SEMI.kingpinToRear + 0.95) / 2;
  const tc = { x: p.x - Math.sin(p.trailer) * (tl - 0.95), z: p.z - Math.cos(p.trailer) * (tl - 0.95) };
  const kl = (SEMI.kingpinToFront + 1.3) / 2;
  const kc = { x: p.x + Math.sin(p.heading) * (kl - 1.3), z: p.z + Math.cos(p.heading) * (kl - 1.3) };
  return [
    { ...tc, hl: tl, hw: 1.3, h: p.trailer },
    { ...kc, hl: kl, hw: 1.25, h: p.heading },
  ];
}

/** 一段路径上最急的转弯半径：沿路径每 1.5 米取一点，用相隔 3 米的三个点的外接圆半径（不受折线细分的影响） */
function minRadius(path: { duration: number; at: (t: number, out: PathState) => void }, from = 0, to = Infinity): number {
  const p: PathState = { x: 0, z: 0, heading: 0 };
  const pts: Array<{ x: number; z: number }> = [];
  path.at(from, p);
  pts.push({ x: p.x, z: p.z });
  for (let t = from + 0.05; t <= Math.min(path.duration, to); t += 0.05) {
    path.at(t, p);
    const last = pts[pts.length - 1] as { x: number; z: number };
    if (Math.hypot(p.x - last.x, p.z - last.z) >= 1.5) pts.push({ x: p.x, z: p.z });
  }
  let r = Infinity;
  for (let i = 2; i < pts.length - 2; i++) {
    const a = pts[i - 2] as { x: number; z: number };
    const b = pts[i] as { x: number; z: number };
    const c = pts[i + 2] as { x: number; z: number };
    const ab = Math.hypot(b.x - a.x, b.z - a.z);
    const bc = Math.hypot(c.x - b.x, c.z - b.z);
    const ca = Math.hypot(a.x - c.x, a.z - c.z);
    const area2 = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    if (area2 > 1e-6) r = Math.min(r, (ab * bc * ca) / (2 * area2));
  }
  return r;
}

const ACCESS: YardAccess[] = [
  { side: 'RIGHT', via: 'DRIVE', offsetM: 24, slots: 0, trailerStalls: 0 },
  { side: 'RIGHT', via: 'STREET', offsetM: 20, slots: 3, trailerStalls: 4 },
  { side: 'LEFT', via: 'DRIVE', offsetM: 24, slots: 0, trailerStalls: 6 },
  { side: 'LEFT', via: 'STREET', offsetM: 16, slots: 2, trailerStalls: 0 },
];

describe('卸货场（决策记录 0018、0019）', () => {
  for (const name of ['medium', 'small'] as const) {
    const model = new StoreModel(createTemplate(name));
    const geo = buildGeometry(model);
    const f0 = geo.floors[0] as (typeof geo.floors)[number];
    const store = { minX: f0.minX, maxX: f0.maxX, minZ: f0.minZ, maxZ: f0.maxZ };
    const doors = backroomLayout(model.config).docks;
    const doorXs = doors.map((d) => d.x);

    it(`${name}：四种进场方式下车道从后墙往外依次排开，待命车位、甩挂车位在场地之内，场地里没有建筑和树`, () => {
      for (const access of ACCESS) {
        for (const style of ['suburban', 'urban', 'arterial'] as RoadStyle[]) {
          for (const layout of ['standard', 'corner', 'strip'] as const) {
            const site = generateSite({ lot: geo.lot, store, settings: { style, seed: 3, traffic: 1, layout }, access, doorXs });
            const y = site.yard;
            const tag = `${access.side}/${access.via}/${style}/${layout}`;
            expect(y.wall, tag).toBeCloseTo(store.maxZ, 6);
            expect(y.wall < y.zCourt && y.zCourt < y.zExit && y.zExit < y.zQueue && y.zQueue < y.zTop && y.zTop < y.z1, tag).toBe(true);
            expect(y.slots, tag).toBeGreaterThanOrEqual(1);
            if (access.slots) expect(y.slots, tag).toBeLessThanOrEqual(access.slots);
            expect(y.xHead, tag).toBeGreaterThan(y.x0);
            if (y.side === 'RIGHT') expect(y.xHead + (y.slots - 1) * y.pitch + 21.65, tag).toBeLessThan(y.xIn - 10);
            else expect(y.xHead + (y.slots - 1) * y.pitch + 21.65, tag).toBeLessThan(y.xEast + 0.01);
            for (const st of y.stalls) {
              expect(st.x - 1.9, tag).toBeGreaterThanOrEqual(y.x0);
              expect(st.x + 1.9, tag).toBeLessThanOrEqual(y.x1);
              expect(st.z + 8.5, tag).toBeLessThanOrEqual(y.z1);
            }
            // 场地不压别的支路（经支路进场时那条支路就是进场道路）
            for (const l of site.lanes.filter((q) => q.kind === 'side')) {
              const x = l.pts[0].x;
              if (Math.abs(x - y.driveX) < y.driveHalf + 0.01) continue;
              expect(x < y.x0 || x > y.x1, `${tag} side lane ${x.toFixed(1)}`).toBe(true);
            }
            // 卸货场里没有建筑和树
            for (const b of site.buildings) expect(b.z - b.d / 2 > y.z1 || b.x + b.w / 2 < y.x0 || b.x - b.w / 2 > y.x1 || b.z + b.d / 2 < y.wall, tag).toBe(true);
            for (const t of site.trees) expect(t.z > y.z1 + 1 || t.x < y.x0 - 1 || t.x > y.x1 + 1 || t.z < y.wall, tag).toBe(true);
          }
        }
      }
    });

    it(`${name}：每个卸货门都能从司机一侧倒进去——挂车在离墙 24 米外摆正，倒车和拉出时不碰两边停着的车；进出的转弯半径不小于 12 米`, () => {
      for (const access of ACCESS) {
        const site = generateSite({ lot: geo.lot, store, settings: { style: 'suburban', seed: 1, traffic: 1 }, access, doorXs });
        const y = site.yard;
        const road = { ...site.road, roadEdgeZ: geo.lot.edgeZ, roadTopZ: site.roadTopZ, street: site.access.via === 'STREET' ? { x: site.access.x, half: site.access.half } : undefined };
        const tag = `${access.side}/${access.via}`;
        for (const [di, d] of doors.entries()) {
          const r = yardRoute(y, road, d.x, 'semi', di % 2 === 0, di % 2 === 1, 20, 20);
          const p: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false };
          // 车道走完（车头外摆停下）与倒车起点衔接
          const drive = laneDrive(r, 0, 3, 0);
          drive.rig?.at(drive.path.duration, p);
          const b0: RigPose = { ...p };
          r.back.rig?.at(0, b0);
          expect(Math.hypot(p.x - b0.x, p.z - b0.z), tag).toBeLessThan(0.6);
          expect(Math.abs(ang(p.trailer, b0.trailer)), tag).toBeLessThan(0.08);
          expect(Math.abs(ang(b0.trailer, 0)), tag).toBeGreaterThan(0.15);
          // 靠稳：挂车摆正、车尾离墙约 0.6 米
          const pk = r.parked;
          expect(Math.abs(ang(pk.trailer, 0)), tag).toBeLessThan(0.03);
          expect(pk.x, tag).toBeCloseTo(d.x, 1);
          const rearZ = pk.z - SEMI.kingpinToRear * Math.cos(pk.trailer);
          expect(rearZ, tag).toBeGreaterThan(y.wall + 0.3);
          expect(rearZ, tag).toBeLessThan(y.wall + 0.9);
          const neighbours = doors
            .filter((o) => o !== d)
            .flatMap((o) => rigBoxes({ x: o.x, z: y.wall + 0.6 + SEMI.kingpinToRear, heading: 0, trailer: 0, reversing: false }));
          const back = r.back.rig;
          expect(back, tag).toBeDefined();
          let alignedAt = -Infinity;
          for (let t = 0; t <= (back?.duration ?? 0); t += 0.25) {
            back?.at(t, p);
            expect(Math.abs(ang(p.trailer, p.heading)), tag).toBeLessThan(1.15);
            for (const box of rigBoxes(p)) for (const n of neighbours) expect(intersects(box, n, 0.15), tag).toBe(false);
            const rz = p.z - SEMI.kingpinToRear * Math.cos(p.trailer);
            if (rz < y.wall + 22.25) expect(Math.abs(ang(p.trailer, 0)), tag).toBeLessThan(0.06);
            if (Math.abs(ang(p.trailer, 0)) > 0.02) alignedAt = Math.max(alignedAt, p.z - SEMI.kingpinToAxle * Math.cos(p.trailer));
            expect(p.z + SEMI.kingpinToFront * Math.cos(p.heading), tag).toBeLessThan(y.zQueue - 1.3);
          }
          expect(alignedAt, tag).toBeGreaterThan(y.wall + 24);
          // 拉出驶离：先笔直拉出，挂车越过两边车头之后才转弯；不碰两边的车，最后回到主路
          const ex = r.exit.rig;
          for (let t = 0; t <= r.exit.path.duration; t += 0.25) {
            ex?.at(t, p);
            if (p.z > y.wall + 60 || p.x > y.x1) continue;
            for (const box of rigBoxes(p)) for (const n of neighbours) expect(intersects(box, n, 0.15), tag).toBe(false);
          }
          ex?.at(r.exit.path.duration, p);
          expect(p.z, tag).toBeLessThan(geo.lot.edgeZ);
          // 转弯半径：主路拐进拐出、卸货场里的转弯都不小于 12 米（洲际半挂车的最小转弯半径约 12.5 米）
          expect(minRadius(r.approach.path), `${tag} approach`).toBeGreaterThan(11.5);
          expect(minRadius(r.laneUnit, 0, r.slotS(0)), `${tag} lane`).toBeGreaterThan(11.5);
          expect(minRadius(r.exit.path), `${tag} exit`).toBeGreaterThan(11.5);
        }
      }
    });
  }

  it('进场道路：专用后勤通道接主路处是半径 15 米的喇叭口，人行道在那里断开；停车场出入口一进一出、中间有隔离岛', () => {
    const model = new StoreModel(createTemplate('medium'));
    const geo = buildGeometry(model);
    const f0 = geo.floors[0] as (typeof geo.floors)[number];
    const store = { minX: f0.minX, maxX: f0.maxX, minZ: f0.minZ, maxZ: f0.maxZ };
    const site = generateSite({ lot: geo.lot, store, settings: { style: 'suburban', seed: 1, traffic: 1 } });
    expect(site.access.via).toBe('DRIVE');
    // 两个喇叭口（后勤通道）+ 每个停车场出入口两个
    expect(site.asphaltPolys.length).toBe(2 + 2 * geo.lot.perimeterX.length);
    const sw = site.roadTopZ + 2.4;
    for (const s2 of site.sidewalks) {
      if (Math.abs(s2.z - (site.roadTopZ + 1.2)) > 0.01) continue;
      const x0 = s2.x - s2.w / 2;
      const x1 = s2.x + s2.w / 2;
      // 人行道不压在后勤通道和停车场出入口上
      expect(x1 <= site.access.x - site.access.half - 14.9 || x0 >= site.access.x + site.access.half + 14.9).toBe(true);
      for (const px of geo.lot.perimeterX) expect(x1 <= px - 4.3 - 5.9 || x0 >= px + 4.3 + 5.9).toBe(true);
    }
    expect(site.medians.length).toBe(geo.lot.perimeterX.length);
    // 喇叭口的圆弧：离拐角最远的点在 15 米处
    const poly = site.asphaltPolys[site.asphaltPolys.length - 1] as Array<{ x: number; z: number }>;
    expect(Math.max(...poly.map((q) => q.z)) - sw).toBeCloseTo(15, 0);
  });

  it('待命车道：按到达先后排队，前面的车进场后往前挪；起步和刹车平稳，不超速', () => {
    const trucks = [
      { arrive: 100, dockAt: 100 },
      { arrive: 160, dockAt: 400 },
      { arrive: 200, dockAt: 700 },
    ];
    const slotS = (j: number) => 200 - j * 24.65;
    expect(queueTargets(trucks, 0, slotS, 3)).toEqual([{ t: 100, s: 200 }]);
    expect(queueTargets(trucks, 1, slotS, 3)).toEqual([{ t: 160, s: 200 }]);
    // 第三辆到达时前面还有一辆在排队：先停第二个车位，前车进场后往前挪到第一个
    expect(queueTargets(trucks, 2, slotS, 3)).toEqual([
      { t: 200, s: 200 - 24.65 },
      { t: 400, s: 200 },
    ]);
    const q = new QueueMotion(200, 700, queueTargets(trucks, 2, slotS, 3), 3.2, 0.5, 0.8, 3.2);
    let prev = 0;
    for (let t = 200; t <= 700; t += 0.5) {
      const m = q.at(t);
      expect(m.v).toBeLessThanOrEqual(3.2 + 1e-6);
      expect(m.s).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = m.s;
      if (t > 330 && t < 400) expect(m.s).toBeCloseTo(200 - 24.65, 1);
    }
    expect(q.end().s).toBeCloseTo(200, 1);
  });

  it('待命车道上的车位按距离从前到后排开，车道位置可以按距离取到', () => {
    const model = new StoreModel(createTemplate('medium'));
    const geo = buildGeometry(model);
    const f0 = geo.floors[0] as (typeof geo.floors)[number];
    const site = generateSite({ lot: geo.lot, store: { minX: f0.minX, maxX: f0.maxX, minZ: f0.minZ, maxZ: f0.maxZ }, settings: { style: 'suburban', seed: 1, traffic: 1 } });
    const y = site.yard;
    const r = yardRoute(y, { ...site.road, roadEdgeZ: geo.lot.edgeZ, roadTopZ: site.roadTopZ }, backroomLayout(model.config).docks[0]?.x ?? f0.maxX - 3, true, true, true);
    const p: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false };
    for (let j = 0; j < y.slots; j++) {
      const s = r.slotS(j);
      expect(s).toBeGreaterThan(0);
      if (j > 0) expect(s).toBeLessThan(r.slotS(j - 1));
      lanePose(r, s, p);
      expect(p.z).toBeCloseTo(y.zQueue, 1);
      // 车头朝 −X，车头对齐车位前沿
      expect(Math.abs(ang(p.heading, -Math.PI / 2))).toBeLessThan(0.02);
      expect(p.x - SEMI.kingpinToFront).toBeCloseTo(y.xHead + j * y.pitch, 1);
    }
  });
});
