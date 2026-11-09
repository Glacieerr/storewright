import { describe, expect, it } from 'vitest';
import { AXLES, BUILDS, LAMPS } from '../web/src/three/fleet';
import { BODY_DIMS, MODEL_SPECS, modelGeometry, modelWithWheels, RIG_DIMS, TOW_DIMS, triangleCounts, wheelGeometry, type ModelKey } from '../web/src/three/vehicles/index';
import { VEHICLE_DIMS } from '@storewright/yard';

/**
 * 车辆模型（vehicles/）的回归测试：每种车型的外形尺寸在公开的常见范围里、和尺寸表一致，车轮在车身范围内，
 * 车灯在车头车尾，铰接车的牵引销、挂车车轴和尺寸表、收货场引擎一致，远近两级的模型都有、三角形数在预算以内，
 * 仿真车辆的车长和锚点没变（运动规划、收货场、设施作业按这些数排）。
 */
const KEYS = Object.keys(MODEL_SPECS) as ModelKey[];

function bbox(key: ModelKey, lod: 'near' | 'far') {
  const g = modelGeometry(key, lod);
  g.computeBoundingBox();
  const b = g.boundingBox as NonNullable<typeof g.boundingBox>;
  return { x0: b.min.x, x1: b.max.x, y0: b.min.y, y1: b.max.y, z0: b.min.z, z1: b.max.z };
}

describe('车辆模型（放样精模 + 远处简模）', () => {
  it('外形尺寸在公开的常见范围里，和尺寸表一致', () => {
    // 车长、车宽、车高的常见范围（米，按公开资料取的假设参数）
    const RANGE: Partial<Record<ModelKey, { L: [number, number]; W: [number, number]; H: [number, number] }>> = {
      car: { L: [4.5, 5.0], W: [1.75, 1.9], H: [1.38, 1.5] },
      hatch: { L: [3.9, 4.45], W: [1.7, 1.85], H: [1.4, 1.55] },
      suv: { L: [4.4, 4.8], W: [1.8, 1.95], H: [1.6, 1.8] },
      mpv: { L: [4.7, 5.2], W: [1.8, 1.95], H: [1.65, 1.95] },
      pickup: { L: [5.3, 6.0], W: [1.85, 2.1], H: [1.8, 2.0] },
      van: { L: [5.5, 6.2], W: [2.0, 2.1], H: [2.4, 2.8] },
      boxTruck: { L: [6.5, 8.5], W: [2.2, 2.4], H: [3.0, 3.6] },
      evTruck: { L: [9.0, 12.0], W: [2.4, 2.55], H: [3.4, 4.0] },
      tractor: { L: [5.6, 7.0], W: [2.4, 2.55], H: [3.5, 4.0] },
      tractorDay: { L: [5.6, 7.0], W: [2.4, 2.55], H: [2.8, 3.3] },
      tractorLong: { L: [6.5, 8.5], W: [2.4, 2.55], H: [3.5, 4.0] },
      trailerPlain: { L: [13.0, 13.75], W: [2.5, 2.55], H: [3.9, 4.0] },
      chassis: { L: [12.0, 12.5], W: [2.4, 2.55], H: [1.2, 1.5] },
      container: { L: [12.19, 12.19], W: [2.44, 2.44], H: [2.59, 2.59] },
      container20: { L: [6.06, 6.06], W: [2.44, 2.44], H: [2.59, 2.59] },
      bus: { L: [11.5, 12.0], W: [2.5, 2.55], H: [3.0, 3.4] },
      rv: { L: [9.0, 12.0], W: [2.4, 2.6], H: [3.4, 3.9] },
      terminalTractor: { L: [5.0, 6.2], W: [2.4, 2.7], H: [2.9, 3.4] },
      yardShunter: { L: [4.8, 5.8], W: [2.4, 2.6], H: [2.8, 3.3] },
    };
    for (const key of KEYS) {
      const s = MODEL_SPECS[key];
      const r = RANGE[key];
      if (r) {
        expect(s.length, `${key} 车长`).toBeGreaterThanOrEqual(r.L[0] - 1e-9);
        expect(s.length, `${key} 车长`).toBeLessThanOrEqual(r.L[1] + 1e-9);
        expect(s.width, `${key} 车宽`).toBeGreaterThanOrEqual(r.W[0] - 1e-9);
        expect(s.width, `${key} 车宽`).toBeLessThanOrEqual(r.W[1] + 1e-9);
        expect(s.height, `${key} 车高`).toBeGreaterThanOrEqual(r.H[0] - 1e-9);
        expect(s.height, `${key} 车高`).toBeLessThanOrEqual(r.H[1] + 1e-9);
      }
      // 外廓限值：车宽 2.55、车高 4.0
      expect(s.width, `${key} 车宽限值`).toBeLessThanOrEqual(2.6);
      expect(s.height, `${key} 车高限值`).toBeLessThanOrEqual(4.0);
      // 简模（没有后视镜）的外形和尺寸表一致；精模车长差不过保险杠、拖钩、冷机、后门锁杆
      const far = bbox(key, 'far');
      expect(far.x1 - far.x0, `${key} 简模车长`).toBeGreaterThan(s.length - 0.4);
      expect(far.x1 - far.x0, `${key} 简模车长`).toBeLessThan(s.length + 0.65);
      expect(far.z1 - far.z0, `${key} 简模车宽`).toBeLessThan(s.width + 0.2);
      expect(far.y1, `${key} 简模车高`).toBeLessThan(s.height + 0.15);
      const near = bbox(key, 'near');
      expect(near.x0, `${key} 精模车尾`).toBeGreaterThan(-0.35);
      expect(near.x1, `${key} 精模车头`).toBeLessThan(s.length + 0.65);
      expect(near.y1, `${key} 精模车高`).toBeLessThan(s.height + 0.15);
      expect(near.y0, `${key} 精模不钻到地下`).toBeGreaterThanOrEqual(-0.01);
    }
  });

  it('车轮在车身范围内、贴着地面；车灯在车头车尾', () => {
    for (const key of KEYS) {
      const s = MODEL_SPECS[key];
      for (const a of s.axles) {
        expect(a.x - a.r, `${key} 车轮在车尾以内`).toBeGreaterThan(-0.3);
        expect(a.x + a.r, `${key} 车轮在车头以内`).toBeLessThan(s.length + 0.05);
        expect(a.half + (a.dual ? 0.3 : 0.15), `${key} 车轮在车宽以内`).toBeLessThanOrEqual(s.width / 2 + 0.06);
        expect(a.r, `${key} 轮半径`).toBeGreaterThan(0.25);
        expect(a.r, `${key} 轮半径`).toBeLessThan(0.6);
      }
      const l = LAMPS[key];
      if (!l) continue;
      for (const p of [l.head, l.frontTurn]) if (p) expect(p[0], `${key} 前灯在车头`).toBeGreaterThan(s.length - 0.3);
      for (const p of [l.tail, l.back, l.rearTurn]) if (p) expect(p[0], `${key} 尾灯在车尾`).toBeLessThan(0.3);
      for (const p of [l.head, l.frontTurn, l.tail, l.back, l.rearTurn]) if (p) expect(p[2], `${key} 车灯在车宽以内`).toBeLessThanOrEqual(s.width / 2 + 0.05);
    }
    // 单位车轮：半径 1、宽 1、车轴沿 z
    for (const kind of ['car', 'truck'] as const) {
      const g = wheelGeometry(kind);
      g.computeBoundingBox();
      const b = g.boundingBox as NonNullable<typeof g.boundingBox>;
      expect(b.max.y).toBeCloseTo(1, 1);
      expect(b.max.x).toBeCloseTo(1, 1);
      expect(b.max.z - b.min.z).toBeLessThan(1.15);
    }
  });

  it('铰接车的尺寸表和收货场引擎一致，车组长度不超过限值', () => {
    // 牵引销到挂车车轴、牵引车前轴到牵引销、车头到牵引销……和收货场引擎（yard/rig.ts）的数一样
    for (const [mine, theirs] of [
      [RIG_DIMS.semi, VEHICLE_DIMS.semi],
      [RIG_DIMS.chassis, VEHICLE_DIMS.chassis],
    ] as const) {
      if (theirs.kind !== 'rig') throw new Error('收货场引擎的铰接车尺寸');
      expect(mine.front).toBeCloseTo(theirs.front, 3);
      expect(mine.tractorRear).toBeCloseTo(theirs.tractorRear, 3);
      expect(mine.trailerFront).toBeCloseTo(theirs.trailerFront, 3);
      expect(mine.rear).toBeCloseTo(theirs.rear, 3);
      expect(mine.axle).toBeCloseTo(theirs.axle, 3);
      expect(mine.wheelbase).toBeCloseTo(theirs.wheelbase, 3);
    }
    const truck = VEHICLE_DIMS.truck;
    const van = VEHICLE_DIMS.van;
    if (truck.kind !== 'body' || van.kind !== 'body') throw new Error('收货场引擎的单体车尺寸');
    expect(BODY_DIMS.truck.length).toBeCloseTo(truck.length, 3);
    expect(BODY_DIMS.truck.wheelbase).toBeCloseTo(truck.wheelbase, 3);
    expect(BODY_DIMS.truck.rearOverhang).toBeCloseTo(truck.rearOverhang, 3);
    expect(BODY_DIMS.van.wheelbase).toBeCloseTo(van.wheelbase, 3);
    expect(BODY_DIMS.van.rearOverhang).toBeCloseTo(van.rearOverhang, 3);
    // 车组长度：铰接列车 17.1 米、长头铰接列车 18.1 米；半挂车 13.75 米以内
    expect(BUILDS.plainDry.L).toBeLessThanOrEqual(17.1);
    expect(BUILDS.longDry.L).toBeLessThanOrEqual(18.1 + 1e-9);
    expect(MODEL_SPECS.trailerPlain.length).toBeLessThanOrEqual(13.75);
    // 挂车车轴组中心、牵引销和尺寸表一致
    const tr = MODEL_SPECS.trailerPlain;
    const axle = tr.axles.reduce((a, b) => a + b.x, 0) / tr.axles.length;
    expect((tr.kingpin as number) - axle).toBeCloseTo(RIG_DIMS.semi.axle, 6);
    // 小拖车：挂钩到车轴的距离（内轮差）
    expect(TOW_DIMS.camper.axle).toBeCloseTo(6.45, 2);
    expect(TOW_DIMS.boat.axle).toBeCloseTo(5.0, 2);
    expect(TOW_DIMS.utility.axle).toBeCloseTo(3.0, 2);
  });

  it('仿真车辆的车长和锚点没变（运动规划、收货场、设施作业按这些数排）', () => {
    const sig = (k: keyof typeof BUILDS) => `${BUILDS[k].L}|${BUILDS[k].parts.map((p) => `${p.slot}:${p.fa}:${p.ra}:${p.ax}:${p.y ?? 0}`).join(',')}`;
    expect(sig('ownDry')).toBe('16.8|tractor:1.1:4.4:4.9:0,trailerDry:4.4:13.9:12.4:0');
    expect(sig('plainReefer')).toBe('16.8|tractor:1.1:4.4:4.9:0,trailerPlainReefer:4.4:13.9:12.4:0');
    expect(sig('ev')).toBe('11|evTruck:1.4:7.6:9.6:0');
    expect(sig('vanOnline')).toBe('6|vanOnline:0.9:4.6:5.1:0');
    expect(sig('drayage')).toBe('15.6|tractor:1.1:4.4:4.9:0,chassis:4.4:13.6:11.2:0,container:4.4:13.6:11.2:1.25');
    expect(sig('drayDay')).toBe('15.6|tractorDay:1.1:4.4:4.9:0,chassis:4.4:13.6:11.2:0,container:4.4:13.6:11.2:1.25');
    // 每个零件的前锚点在零件里、两个锚点之间的距离和尺寸表的车轴一致
    for (const [k, b] of Object.entries(BUILDS)) {
      for (const p of b.parts) {
        expect(p.ax, `${k} ${p.slot} 前锚点在零件里`).toBeLessThanOrEqual(MODEL_SPECS[p.slot].length + 1e-9);
        expect(p.ra, `${k} ${p.slot} 后锚点在前锚点后面`).toBeGreaterThan(p.fa);
      }
      expect(b.L, `${k} 整车长`).toBeGreaterThanOrEqual(Math.max(...b.parts.map((p) => p.fa + p.ax)) - 1e-6);
    }
  });

  it('远近两级的模型都有、带车漆遮罩和粗糙度，三角形数在预算以内', () => {
    const tri = triangleCounts();
    for (const key of KEYS) {
      for (const lod of ['near', 'far'] as const) {
        const g = modelGeometry(key, lod);
        for (const name of ['position', 'normal', 'color', 'aPaint', 'aRough']) expect(g.getAttribute(name), `${key} ${lod} 的 ${name}`).toBeTruthy();
        const n = g.getAttribute('position').count;
        expect(n % 3, `${key} ${lod} 三角形`).toBe(0);
        const p = g.getAttribute('position').array as Float32Array;
        expect(p.every((v) => Number.isFinite(v)), `${key} ${lod} 坐标是有限的数`).toBe(true);
      }
      expect(tri[key].far, `${key} 简模的三角形数`).toBeLessThanOrEqual(800);
      expect(tri[key].near, `${key} 精模的三角形数`).toBeLessThanOrEqual(20000);
      expect(tri[key].far, `${key} 简模比精模省`).toBeLessThan(Math.max(80, tri[key].near));
      // 有车轮的车型：精模不含车轮（单独画），整体模型把简化车轮合进去
      if (AXLES[key]?.length) expect(modelWithWheels(key).getAttribute('position').count).toBeGreaterThan(modelGeometry(key, 'near').getAttribute('position').count);
    }
    // 车漆遮罩：乘用车的车身有车漆（乘实例颜色），车窗、灯不是
    const car = modelGeometry('car', 'near');
    const mask = car.getAttribute('aPaint').array as Float32Array;
    const painted = mask.filter((v) => v > 0.5).length / mask.length;
    expect(painted).toBeGreaterThan(0.3);
    expect(painted).toBeLessThan(0.95);
  });
});
